import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { budgetGuard, shouldAutoConfirm, retryTargets, pickDuration } from '../decisions.js';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState, projectSpentPoints, stateDir } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { buildVariantGenerateBody } from '../story/prompt.js';
import { missingAssetTemplates, missingAssetRatios, resolveAssetTemplateForAsset, styleWikiIdFromMetadata, ratioKeyFor, assetNeedsSubjectImage } from '../story/templates.js';
import { projectSettingsReady } from '../story/analysis.js';
import { auditAssetPrompts } from '../story/asset-audit.js';
import { variantHasImage } from '../story/image-state.js';
import { resolveAssetReferenceImage } from '../story/asset-reference.js';
import { findVideoTool } from '../story/video-model.js';
import { findImageTool as findConfiguredImageTool } from '../story/image-model.js';
import { ensureAssetMainImage } from '../story/ensure-main.js';
import { buildShotVideoItemFromParts, buildShotVideoTaskConfig } from '../story/payload.js';
import { buildRefIndex, compileShotRefs } from '../story/refs.js';
import { ensureCanvas, resolveUserFileIdByUrl, resolveUserFileIdByTask, syncGeneratedResult, findImageTool, findToolBySlug, submitVariantGenerate, waitTaskStatuses } from '../story/client.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_run_advance',
        description:
          '推进一次 run：assets=给缺图变体出图（默认 1 张），shots=按分镜逐个出视频（默认 1 镜；逐镜独立提示词与参考图，完成后自愈 shot output）。',
        parameters: {
          runId: { type: 'string', description: 'run_start 返回的 runId' },
          stage: { type: 'string', description: 'assets / shots（默认 assets）' },
          limit: { type: 'number', description: '本次生成张数（默认=项目 imageParallelism，当前默认 10）' },
          modelName: { type: 'string', description: '图片模型（默认见 config.imageModel）' },
          aspect: { type: 'string', description: '画幅（默认 9:16）' },
          assetType: { type: 'string', description: '只生成某类资产：character/scene/item/creature（可空）' },
          assetName: { type: 'string', description: '只生成某个资产（按名称精确匹配，可空）' },
          variantName: { type: 'string', description: '只生成某个变体（按变体名精确匹配，可空；配合 assetName 补参考图）' },
          videoModelSlug: { type: 'string', description: '视频模型 slug（可空=项目默认；显式指定时按该模型生成，不自动切换）' },
          shotLimit: { type: 'number', description: '本次生成几个分镜（默认=项目 videoParallelism，当前默认 3；每个分镜 1 个任务）' },
          shotNo: { type: 'number', description: '只处理某个分镜号（可空；用于定点补生成）' },
          shotNos: { type: 'array', items: { type: 'number' }, description: '只处理指定分镜号列表（可空；优先于 shotNo）' },
          force: { type: 'boolean', description: '强制重跑（默认 false；已完成的 stage 会跳过）' },
          retryFailed: { type: 'boolean', description: '资产图失败后自动重试 1 次（默认 false）' },
          strictRefs: { type: 'boolean', description: '参考图有问题时阻止分镜下单（默认 false，只告警）' },
          assetAudit: { type: 'string', description: '资产生成前提示词审计：strict / warn / off（默认 strict）' },
          duration: { type: 'number', description: '视频时长秒（可空：按分镜 durationSeconds 自动选模型支持的档位）' },
          budgetPoints: { type: 'number', description: '本次预算覆盖（可空=用 state 里的预算）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              stage: { type: 'string' },
              generatedCount: { type: 'number' },
              syncedCount: { type: 'number' },
              healedCount: { type: 'number' },
              confirmedCount: { type: 'number' },
              estimatedCost: { type: 'number' },
              message: { type: 'string' },
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    variantId: { type: 'string' },
                    taskId: { type: 'string' },
                    status: { type: 'string' },
                  },
                },
              },
              blockers: { type: 'array', items: { type: 'string' } },
              refIssues: { type: 'array', items: { type: 'string' } },
              durations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    shotNo: { type: 'number' },
                    target: { type: 'number' },
                    chosen: { type: 'number' },
                  },
                },
              },
              durationWarnings: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(`advance ${value.runId}: ${value.stage}（生成 ${value.generatedCount} 张，回写 ${value.syncedCount} 个，自愈 ${value.healedCount || 0} 个 output，确认 ${value.confirmedCount || 0} 个）`);
            if (value.estimatedCost) lines.push(`- 预估消耗: ${value.estimatedCost} 点`);
            if (value.message) lines.push(`- ${value.message}`);
            for (const t of value.tasks || []) {
              lines.push(`  · ${t.variantId.slice(0, 8)} → task ${t.taskId.slice(0, 8)} ${t.status}`);
            }
            if (value.durations?.length) {
              for (const d of value.durations) lines.push(`  · 分镜 ${d.shotNo}: 目标 ${d.target || '-'}s → 采用 ${d.chosen}s`);
            }
            if (value.durationWarnings?.length) {
              for (const w of value.durationWarnings) lines.push(`  ! 时长: ${w}`);
            }
            if (value.refIssues?.length) {
              for (const issue of value.refIssues) lines.push(`  ! 参考图: ${issue}`);
            }
            if (value.blockers?.length) {
              for (const b of value.blockers) lines.push(`  · ${b}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const runId = String(args?.runId || '');
          const stage = String(args?.stage || 'assets');
          let limit = Math.max(1, Number(args?.limit || 1));
          const blockers = [];
          const tasks = [];
          let syncedCount = 0;
          let healedCount = 0;
          const refIssues = [];
          const durationPlan = [];
          const durationWarnings = [];
          let confirmedCount = 0;
          let needHuman = false;
          let message = '';
          let imageCost = cfg.unitCost.image;
          let ensuredMainCount = 0;
          let videoCost = cfg.unitCost.video;
          const force = args?.force === true;

          const state = readRunState(runId);
          if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
          if (stage !== 'assets' && stage !== 'shots') blockers.push(`stage=${stage} 暂未实现（支持 assets / shots）`);

          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          let tool = null;
          let projectMeta = {};
          if (state && token) {
            const projectRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
            projectMeta = projectRes.json?.data?.metadata && typeof projectRes.json.data.metadata === 'object' ? projectRes.json.data.metadata : {};
    if (!projectSettingsReady(projectMeta)) blockers.push('请先到任务列表打开项目设置并保存，完成项目设置后再生成资产/分镜');
          }
          const imageParallelism = Math.max(1, Math.min(10, Number(projectMeta.imageParallelism) || 10));
          const videoParallelism = Math.max(1, Math.min(10, Number(projectMeta.videoParallelism) || 3));
          limit = Math.min(imageParallelism, Math.max(1, Number(args?.limit || imageParallelism)));
          const imageSlug = String(args?.imageModelSlug || projectMeta.imageModelSlug || state?.settings?.imageModelSlug || cfg.imageModelSlug || '');
          const imageName = String(args?.modelName || state?.settings?.imageModel || cfg.imageModel || '');
          if (state && token && !blockers.length) {
            const imageToolsRes = await httpJson(`${base}/api/v1/tools?limit=500`, { token });
            const imageToolItems = imageToolsRes.json?.data?.items || [];
            const configuredImageTool = findConfiguredImageTool(imageToolItems, projectMeta, args?.imageModelSlug);
            const effectiveImageSlug = String(configuredImageTool?.slug || imageSlug || '');
            tool = configuredImageTool
              || (effectiveImageSlug ? await findToolBySlug(base, token, effectiveImageSlug) : await findImageTool(base, token, imageName));
            if (!tool) blockers.push(`图片模型不存在：${effectiveImageSlug || imageName}`);
            imageCost = Number(tool?.estimatedCost) || cfg.unitCost.image;
          }

          const effectiveAssetReview = String(projectMeta.assetReview || state?.settings?.assetReview || 'manual');
          if (stage === 'shots' && state && effectiveAssetReview === 'manual' && (!state.assetsConfirmed || state.assetsConfirmedBy !== 'user')) {
            blockers.push('manual 模式：资产图需要用户本人确认，确认时传 myreels_run_confirm(confirmedBy="user") 后才能生成分镜');
          }

          if (state && token && stage === 'shots' && !blockers.length) {
            const epShots = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
            const shots = epShots.json?.data?.items || [];
            const projForVideo = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
            const videoRatio = String(projForVideo.json?.data?.metadata?.defaultVideoRatio || state.settings?.aspect || cfg.defaultAspect);
            const shotCfg = { ...cfg, defaultAspect: videoRatio };
            if (!shots.length) blockers.push('该集没有分镜');
            const toolsRes = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
            const toolItems = toolsRes.json?.data?.items || [];
            const projectPendingTaskIds = (() => {
              const ids = new Set();
              const now = Date.now();
              try {
                for (const file of readdirSync(stateDir())) {
                  if (!file.endsWith('.json')) continue;
                  let candidate;
                  try { candidate = readRunState(file.replace(/\.json$/i, '')); } catch { continue; }
                  if (!candidate || candidate.projectId !== state.projectId) continue;
                  for (const t of Array.isArray(candidate.shotTasks) ? candidate.shotTasks : []) {
                    const status = String(t.status || '');
                    if (!['pending', 'processing', 'running'].includes(status)) continue;
                    const at = Date.parse(String(t.submittedAt || ''));
                    if (Number.isFinite(at) && now - at >= 30 * 60 * 1000) continue;
                    if (t.taskId) ids.add(String(t.taskId));
                  }
                }
              } catch { /* state dir may not exist on first run */ }
              return ids;
            })();
            const availableVideoSlots = Math.max(0, videoParallelism - projectPendingTaskIds.size);
            if (!availableVideoSlots) blockers.push(`项目视频并行数已满（${videoParallelism}），等待已有任务完成`);
            const shotLimit = Math.min(videoParallelism, availableVideoSlots, Math.max(1, Number(args?.shotLimit || videoParallelism)));
            const requestedNos = Array.isArray(args?.shotNos)
              ? args.shotNos.map((n) => Number(n)).filter(Number.isFinite)
              : args?.shotNo
                ? [Number(args.shotNo)].filter(Number.isFinite)
                : [];
            let remainingShots = requestedNos.length
              ? shots.filter((s) => requestedNos.includes(Number(s.shotNo)))
              : shots;
            const hasShotVideo = (shot) => {
              if (String(shot?.url || '').trim()) return true;
              const latest = shot?.outputs?.latestVideo;
              return latest?.status === 'completed' && Boolean(latest?.url || latest?.userFileId);
            };
            if (!force) remainingShots = remainingShots.filter((s) => !hasShotVideo(s));
            let targetShots = remainingShots.slice(0, shotLimit);
            const nowMs = Date.now();
            const pendingShotIds = new Set((Array.isArray(state.shotTasks) ? state.shotTasks : [])
              .filter((t) => ['pending', 'processing', 'running'].includes(String(t.status || '')))
              .filter((t) => {
                const at = Date.parse(String(t.submittedAt || ''));
                return !Number.isFinite(at) || nowMs - at < 30 * 60 * 1000;
              })
              .map((t) => String(t.shotId || ''))
              .filter(Boolean));
            if (pendingShotIds.size) {
              targetShots = targetShots.filter((s) => !pendingShotIds.has(String(s.id)));
              blockers.push(`${pendingShotIds.size} 个分镜任务仍在跑，等待完成后再提交，避免重复扣点`);
            }
            if (!targetShots.length) {
              if (!pendingShotIds.size) {
                writeRunState(runId, { ...state, shotsDone: true, stage: 'SHOTS_DONE' });
                blockers.push('分镜视频已完成');
              }
            }
            const projectVideoMeta = projForVideo.json?.data?.metadata && typeof projForVideo.json.data.metadata === 'object'
              ? projForVideo.json.data.metadata
              : {};
            const requestedSlug = String(args?.videoModelSlug || '');
            const resolvedVideoTool = findVideoTool(toolItems, projectVideoMeta, requestedSlug);
            const videoSlug = String(resolvedVideoTool?.slug || requestedSlug || projectVideoMeta.videoModelSlug || state.settings?.videoModelSlug || cfg.videoModelSlug || '');
            const videoTool = resolvedVideoTool
              || toolItems.find((x) => x.slug === videoSlug)
              || toolItems.find((x) => String(x.modelName) === videoSlug)
              || null;
            if (!videoTool) blockers.push(`视频模型不存在：${videoSlug}`);
            videoCost = Number(videoTool?.estimatedCost) || cfg.unitCost.video;
            if (videoTool) {
              shotCfg.videoModel = String(videoTool.modelName && videoTool.modelName !== '{{model}}' ? videoTool.modelName : (videoTool.name || videoTool.slug || shotCfg.videoModel));
              shotCfg.videoModelSlug = String(videoTool.slug || videoSlug);
            }
            shotCfg.videoSchema = videoTool?.userInputSchema || null;
            const videoSchema = videoTool?.userInputSchema || {};
            const hasVideoRatio = ['aspect_ratio', 'ratio', 'aspectRatio', 'image_aspect_ratio', 'output_aspect_ratio'].some((k) => Object.prototype.hasOwnProperty.call(videoSchema, k));
            const hasVideoDuration = ['duration', 'duration_seconds', 'target_duration_seconds', 'end_seconds', 'max_clip_seconds'].some((k) => Object.prototype.hasOwnProperty.call(videoSchema, k));
            if (videoTool && !hasVideoRatio) blockers.push(`视频模型 ${videoSlug} 不支持画幅控制（schema 无 ratio/aspect 字段），拒绝生成以免画幅失效`);
            if (videoTool && !hasVideoDuration) blockers.push(`视频模型 ${videoSlug} 不支持时长控制（schema 无 duration 字段），拒绝生成`);
            const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
            const assetItems = assetsRes.json?.data?.items || [];
            const variantsByAsset = new Map();
            for (const asset of assetItems) {
              const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
              const variants = (vs.json?.data?.items || []).map((v) => ({ ...v }));
              for (const variant of variants) {
                if (!variant.userFileId) continue;
                const dl = await httpJson(`${base}/api/v1/user-files/download/${variant.userFileId}`, { token });
                const signed = dl.json?.data;
                if (typeof signed === 'string' && signed.startsWith('http')) variant.imageUrl = signed;
              }
              variantsByAsset.set(asset.id, variants);
            }
            const refIndex = buildRefIndex(assetItems, variantsByAsset);
            const durationOptions = ((videoTool?.userInputSchema?.duration?.options) || [])
              .map((o) => Number(o.value))
              .filter((n) => Number.isFinite(n) && n > 0)
              .sort((a, b) => a - b);
            const maxDuration = durationOptions.length ? durationOptions[durationOptions.length - 1] : 0;
            const overrideDuration = Number(args?.duration || 0);
            let durationBlocked = false;
            const generationItems = targetShots.map((shot) => {
              const compiled = compileShotRefs(shot.prompt || shot.description, refIndex);
              for (const issue of compiled.issues) {
                refIssues.push(`分镜 ${shot.shotNo}：${issue.variant || issue.asset}（${issue.status}）`);
              }
              const target = Number(shot.durationSeconds) || 0;
              const chosen = pickDuration(target, durationOptions, overrideDuration);
              durationPlan.push({ shotNo: shot.shotNo, target, chosen });
              if (maxDuration && target > maxDuration) {
                if (overrideDuration > 0 && overrideDuration <= maxDuration) {
                  durationWarnings.push(`分镜 ${shot.shotNo} 目标 ${target}s，已按显式 duration=${overrideDuration}s 截到模型上限`);
                } else {
                  durationBlocked = true;
                  blockers.push(`分镜 ${shot.shotNo} 目标 ${target}s 超过 ${videoSlug} 单段上限 ${maxDuration}s；不会自动切换模型，请显式指定支持该时长的 videoModelSlug、用 myreels_shot_split 拆短，或显式指定不超过 ${maxDuration}s 的 duration`);
                }
              }
              return buildShotVideoItemFromParts(shot, compiled.prompt, compiled.images, shotCfg, chosen);
            });
            const refBlocked = args?.strictRefs === true && refIssues.length > 0;
            if (refBlocked) {
              blockers.push(`参考图有问题（strictRefs）：${refIssues.slice(0, 5).join('；')}`);
            }
            const generationTaskConfig = videoTool ? buildShotVideoTaskConfig(videoTool, shotCfg) : null;
            const skipShots = (state.shotsDone === true && !force) || !targetShots.length;
            if (skipShots) {
              message = '分镜视频已完成，跳过下单（需强制重跑传 force=true）';
            } else if (refBlocked || durationBlocked) {
              message = '分镜生成被阻止（参考图/模型/时长限制），未下单';
            } else {
            const preBudget = Number(args?.budgetPoints ?? projectMeta.runBudgetPoints ?? state.settings?.budgetPoints ?? 0);
            const preSpent = Math.max(Number(state.spentPoints || 0), projectSpentPoints(state.projectId));
            const preGuard = budgetGuard({ budget: preBudget, spent: preSpent, nextCost: targetShots.length * videoCost });
            if (!preGuard.allow) {
              blockers.push(preGuard.reason);
              message = preGuard.reason;
            } else {
            const gen = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots/generate-video-batch`, {
              method: 'POST',
              token,
              body: {
                shotIds: targetShots.map((s) => s.id),
                targetScope: 'selected',
                generationItems,
                storyProjectId: state.projectId,
                ...(generationTaskConfig ? { generationTaskConfig } : {}),
                ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                ...(state.canvasProjectId ? { canvasProjectId: Number(state.canvasProjectId) } : {}),
              },
            });
            const genItems = gen.json?.data?.items || [];
            const pairs = genItems
              .map((x) => ({
                shotId: String(x.targetId || x.shotId || x.metadata?.shotId || ''),
                taskId: String(x.taskId || x.metadata?.taskId || ''),
              }))
              .filter((x) => x.taskId);
            if (pairs.length) {
              const unitCost = videoCost;
              const projected = pairs.length * unitCost;
              const spent = Math.max(Number(state.spentPoints || 0), projectSpentPoints(state.projectId));
              const budget = Number(args?.budgetPoints ?? projectMeta.runBudgetPoints ?? state.settings?.budgetPoints ?? 0);
              const guard = budgetGuard({ budget, spent, nextCost: projected });
              const budgetBlocked = !guard.allow;
              if (budgetBlocked) blockers.push(guard.reason);
              if (!budgetBlocked) {
              const submittedAt = new Date().toISOString();
              const shotTaskLedger = (Array.isArray(state.shotTasks) ? state.shotTasks : [])
                .filter((t) => !pairs.some((p) => String(p.shotId) === String(t.shotId)))
                .concat(pairs.map((p) => ({ shotId: p.shotId, taskId: p.taskId, status: 'pending', submittedAt })));
              state.shotTasks = shotTaskLedger;
              writeRunState(runId, { ...state, stage: 'SHOTS_RUNNING', lastAdvanceAt: submittedAt, shotTasks: shotTaskLedger });
              const st = await waitTaskStatuses(base, token, pairs.map((x) => x.taskId), { intervalMs: 30000, maxRounds: 80 });
              for (const pair of pairs) tasks.push({ variantId: pair.shotId, taskId: pair.taskId, status: st.get(pair.taskId) || 'unknown' });
              for (const pair of pairs) {
                if ((st.get(pair.taskId) || '') !== 'completed') continue;
                const outs = await httpJson(`${base}/api/v1/story-shots/${pair.shotId}/outputs`, { token });
                const list = outs.json?.data?.items || outs.json?.data || [];
                const bound = (Array.isArray(list) ? list : []).find((x) => String(x.taskId || '') === pair.taskId);
                if (bound && bound.status === 'completed' && (bound.url || bound.userFileId)) continue;
                const t = await httpJson(`${base}/api/v1/tasks/${pair.taskId}`, { token });
                const resultUrl = (t.json?.data?.resultUrls || [])[0]?.url || '';
                if (!resultUrl) continue;
                const userFileId = await resolveUserFileIdByTask(base, token, pair.taskId, resultUrl);
                if (!userFileId) {
                  const sync = await syncGeneratedResult(base, token, {
                    targetType: 'shot',
                    storyProjectId: state.projectId,
                    ...(state.canvasProjectId ? { canvasProjectId: Number(state.canvasProjectId) } : {}),
                    ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                    shotId: pair.shotId,
                    taskId: pair.taskId,
                    episodeId: state.episodeId,
                    url: resultUrl,
                    thumbnailUrl: (t.json?.data?.resultUrls || [])[0]?.thumbnailUrl,
                  });
                  if (sync.status === 200 || sync.status === 201) healedCount += 1;
                  continue;
                }
                const imp = await httpJson(`${base}/api/v1/story-shots/${pair.shotId}/outputs/import-from-user-file`, {
                  method: 'POST',
                  token,
                  body: {
                    storyProjectId: state.projectId,
                    ...(state.canvasProjectId ? { canvasProjectId: Number(state.canvasProjectId) } : {}),
                    ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                    userFileId,
                    shotId: pair.shotId,
                    outputType: 'video',
                    url: resultUrl,
                  },
                });
                if (imp.status === 200 || imp.status === 201) healedCount += 1;
              }
              for (const pair of pairs) {
                if ((st.get(pair.taskId) || '') !== 'completed') continue;
                const outs = await httpJson(`${base}/api/v1/story-shots/${pair.shotId}/outputs`, { token });
                const list = outs.json?.data?.items || outs.json?.data || [];
                const completed = (Array.isArray(list) ? list : []).filter((x) => x.status === 'completed' && (x.url || x.userFileId));
                const chosen = completed.find((x) => String(x.taskId || '') === pair.taskId) || completed[0];
                if (chosen?.id) {
                  const current = shots.find((s) => s.id === pair.shotId) || {};
                  await httpJson(`${base}/api/v1/story-shots/${pair.shotId}`, {
                    method: 'PUT',
                    token,
                    body: {
                      url: chosen.url || current.url || '',
                      thumbnailUrl: chosen.thumbnailUrl || current.thumbnailUrl || '',
                      userFileId: chosen.userFileId || current.userFileId || '',
                      taskId: pair.taskId,
                      metadata: {
                        ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
                        selectedVideoOutputId: chosen.id,
                        selectedVideoOutputAt: new Date().toISOString(),
                      },
                    },
                  });
                }
              }
              const afterShotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
              const afterShots = afterShotsRes.json?.data?.items || [];
              const allShotsDone = afterShots.length > 0 && afterShots.every((s) => String(s.url || '').trim());
              writeRunState(runId, {
                ...state,
                stage: allShotsDone ? 'SHOTS_DONE' : 'SHOTS_PARTIAL',
                lastAdvanceAt: new Date().toISOString(),
                shotsDone: allShotsDone,
                healedCount,
                spentPoints: Number(state.spentPoints || 0) + projected,
                shots: (state.shots || []).concat(tasks.map((t) => ({ shotId: t.variantId, taskId: t.taskId, status: t.status }))),
                shotTasks: (Array.isArray(state.shotTasks) ? state.shotTasks : [])
                  .filter((t) => !pairs.some((p) => String(p.shotId) === String(t.shotId)))
                  .concat(pairs.map((p) => ({
                    shotId: p.shotId,
                    taskId: p.taskId,
                    status: st.get(p.taskId) || 'unknown',
                    submittedAt: new Date().toISOString(),
                  }))),
              });
              }
            } else {
              blockers.push(`提交视频失败（${gen.status}）：${JSON.stringify(gen.json).slice(0, 180)}`);
            }
            }
            }
          }

          if (state && token && stage === 'assets') {
            const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
            const meta = proj.json?.data?.metadata;
            const missing = missingAssetTemplates(meta);
            if (missing.length) blockers.push(`资产模板未选（${missing.join(', ')}）；先 myreels_templates 列出并让用户选择，set 写入项目后再生成`);
            const missingRatio = missingAssetRatios(meta);
            if (missingRatio.length) blockers.push(`资产比例未设（${missingRatio.join(', ')}）；先 myreels_templates set 自动推荐并写入比例`);
            const auditMode = String(args?.assetAudit || 'strict').toLowerCase();
            if (auditMode !== 'off' && !blockers.length) {
              const auditAssetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
              const auditAssets = auditAssetsRes.json?.data?.items || [];
              const auditVariants = new Map();
              for (const asset of auditAssets) {
                const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
                auditVariants.set(asset.id, vs.json?.data?.items || []);
              }
              const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
              const audit = auditAssetPrompts({ assets: auditAssets, variantsByAsset: auditVariants, shots: shotsRes.json?.data?.items || [] });
              if (auditMode === 'strict' && audit.blockers.length) {
                for (const item of audit.blockers.slice(0, 12)) blockers.push(`资产审计未通过：${item}`);
                blockers.push('先修正提示词/描述，或 myreels_asset_audit 查看全部问题');
              }
              if (effectiveAssetReview === 'manual' && !state.assetPromptsConfirmed) {
                blockers.push('manual 模式：先用 myreels_asset_audit 审查完整提示词/参考素材，再 confirm=true + reviewNotes 确认，之后才能生成资产图');
              }
            }
          }

          if (state && token && tool && stage === 'assets' && !blockers.length) {
            const projMetaRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
            const projMeta = projMetaRes.json?.data?.metadata || {};
            const templateCache = new Map();
            const ratioCache = new Map();
            const referenceCache = new Map();
            const referenceFor = async (asset) => {
              if (!assetNeedsSubjectImage(asset?.assetType)) return '';
              if (!referenceCache.has(asset.id)) {
                referenceCache.set(asset.id, await resolveAssetReferenceImage(base, token, asset));
              }
              return referenceCache.get(asset.id);
            };
            const templateFor = async (asset) => {
              const key = String(asset?.id || '');
              if (!templateCache.has(key)) {
                let template = await resolveAssetTemplateForAsset(base, token, asset, asset?.assetType, projMeta, '', true);
                if (!template.id) {
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  template = await resolveAssetTemplateForAsset(base, token, asset, asset?.assetType, projMeta, '', true);
                }
                templateCache.set(key, template);
              }
              return templateCache.get(key);
            };
            const ratioFor = (assetType) => {
              if (!ratioCache.has(assetType)) {
                ratioCache.set(assetType, String(projMeta[ratioKeyFor(assetType)] || state.settings?.aspect || '9:16'));
              }
              return ratioCache.get(assetType);
            };
            const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
            const assets = assetsRes.json?.data?.items || [];
            const onlyType = String(args?.assetType || '');
            const onlyName = String(args?.assetName || '');
            const onlyVariant = String(args?.variantName || '');
            const candidates = [];
            for (const asset of assets) {
              if (onlyType && asset.assetType !== onlyType) continue;
              if (onlyName && asset.name !== onlyName) continue;
              const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
              for (const v of vs.json?.data?.items || []) {
                if (onlyVariant && v.name !== onlyVariant) continue;
                const s = String(v.status || '');
                if (!variantHasImage(v) && s !== 'pending' && s !== 'processing') {
                  candidates.push({ assetId: asset.id, assetType: asset.assetType, variantId: v.id, variantName: v.name, asset, variant: v });
                }
              }
              if (candidates.length >= limit) break;
            }
            const picked = candidates.slice(0, limit);
            if (!picked.length) {
              blockers.push('没有可生成的资产变体（可能都已出图）');
            }
            const mainAssetIds = [...new Set(picked.map((item) => item.assetId))];
            await Promise.all(mainAssetIds.map(async (assetId) => {
              const asset = assets.find((x) => x.id === assetId);
              if (!asset || !assetNeedsSubjectImage(asset.assetType)) return;
              if (String(asset.referenceImageUrl || '').trim()) return;
              const ensured = await ensureAssetMainImage({
                base,
                token,
                asset,
                metadata: projMeta,
                tool,
                state,
              });
              if (ensured.url) {
                asset.referenceImageUrl = ensured.url;
                if (!ensured.fallback) ensuredMainCount += 1;
              } else {
                blockers.push(`资产主图生成失败（${asset.name}）：${ensured.blocker || '未知原因'}，已阻止变体生成`);
              }
            }));
            const assetBudget = Number(args?.budgetPoints ?? projectMeta.runBudgetPoints ?? state.settings?.budgetPoints ?? 0);
            const assetGuard = budgetGuard({ budget: assetBudget, spent: projectSpentPoints(state.projectId), nextCost: (picked.length + ensuredMainCount) * imageCost });
            if (!assetGuard.allow) blockers.push(assetGuard.reason);
            const submitted = [];
            for (const item of assetGuard.allow && !blockers.length ? picked : []) {
              const asset = assets.find((x) => x.id === item.assetId);
              const template = await templateFor(asset);
              const templateId = template.id;
              if (!templateId) {
                blockers.push(`资产 ${item.variantId.slice(0, 8)} 缺少 ${item.assetType} 模板 id`);
                continue;
              }
              const referenceImage = asset ? await referenceFor(asset) : '';
              const body = buildVariantGenerateBody(tool, { aspect: ratioFor(item.assetType), assetType: item.assetType, templateId, styleWikiId: styleWikiIdFromMetadata(projMeta), referenceImage });
              const r = await submitVariantGenerate(base, token, item.variantId, body);
              if (r.status >= 200 && r.status < 300 && r.taskId) {
                submitted.push({ variantId: item.variantId, assetId: item.assetId, taskId: r.taskId, status: 'pending' });
              } else {
                blockers.push(`提交失败 ${item.variantId.slice(0, 8)}（${r.status}）`);
              }
            }
            if (submitted.length) {
              writeRunState(runId, {
                ...state,
                stage: 'ASSETS_RUNNING',
                lastAdvanceAt: new Date().toISOString(),
                spentPoints: Number(state.spentPoints || 0) + (submitted.length + ensuredMainCount) * imageCost,
                pendingTasks: submitted.map((x) => ({ ...x, asset: 'assets' })),
              });
              const statuses = await waitTaskStatuses(base, token, submitted.map((x) => x.taskId));
              if (args?.retryFailed === true) {
                const retryable = retryTargets(
                  submitted.map((x) => ({ ...x, status: statuses.get(x.taskId) || 'pending' })),
                  1,
                );
                for (const item of retryable) {
                  const asset = assets.find((x) => x.id === item.assetId);
                  const template = await templateFor(asset);
                  const templateId = template.id;
                  if (!templateId) continue;
                  const referenceImage = asset ? await referenceFor(asset) : '';
                  const r = await submitVariantGenerate(base, token, item.variantId, buildVariantGenerateBody(tool, { aspect: ratioFor(item.assetType), assetType: item.assetType, templateId, styleWikiId: styleWikiIdFromMetadata(projMeta), referenceImage }));
                  if (r.taskId) {
                    const st2 = await waitTaskStatuses(base, token, [r.taskId], { intervalMs: 15000, maxRounds: 25 });
                    statuses.set(r.taskId, st2.get(r.taskId) || 'unknown');
                    item.taskId = r.taskId;
                  }
                }
              }
              for (const item of submitted) {
                const s = statuses.get(item.taskId) || 'unknown';
                tasks.push({ variantId: item.variantId, taskId: item.taskId, status: s });
              }
              const canvasProjectId = await ensureCanvas(base, token, state.projectId, state.groupId, '');
              for (const item of submitted) {
                if ((statuses.get(item.taskId) || '') !== 'completed') continue;
                const vs = await httpJson(`${base}/api/v1/story-assets/${item.assetId}/variants`, { token });
                const variant = (vs.json?.data?.items || []).find((x) => x.id === item.variantId);
                const url = String(variant?.imageUrl || '');
                if (!url) continue;
                const userFileId = await resolveUserFileIdByUrl(base, token, url, item.taskId);
                const common = {
                  storyProjectId: state.projectId,
                  ...(canvasProjectId ? { canvasProjectId } : {}),
                  ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                  url,
                  ...(userFileId ? { userFileId } : {}),
                  taskId: item.taskId,
                };
                const rv = await syncGeneratedResult(base, token, { ...common, targetType: 'asset_variant', variantId: item.variantId, assetId: item.assetId });
                if (rv.status === 200) syncedCount += 1;
              }
              if (shouldAutoConfirm(effectiveAssetReview)) {
                for (const item of submitted) {
                  if ((statuses.get(item.taskId) || '') !== 'completed') continue;
                  const vs = await httpJson(`${base}/api/v1/story-assets/${item.assetId}/variants`, { token });
                  const variant = (vs.json?.data?.items || []).find((x) => x.id === item.variantId);
                  if (!variant?.imageUrl) continue;
                  const meta = variant.metadata && typeof variant.metadata === 'object' ? variant.metadata : {};
                  const rc = await httpJson(`${base}/api/v1/story-asset-variants/${variant.id}`, {
                    method: 'POST',
                    token,
                    body: { metadata: { ...meta, confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: 'agent' } },
                  });
                  if (rc.status === 200) confirmedCount += 1;
                }
              } else if (submitted.length) {
                needHuman = true;
                message = '资产图已出，等待人工确认（myreels_run_confirm）';
              }
              const latest = readRunState(runId) || state;
              writeRunState(runId, {
                ...latest,
                stage: 'ASSETS_DONE',
                lastAdvanceAt: new Date().toISOString(),
                canvasProjectId,
                syncedCount,
                needHuman,
                refIssues,
                generated: (latest.generated || []).concat(tasks.map((t) => ({ variantId: t.variantId, taskId: t.taskId, status: t.status }))),
              });
            }
          }

          const generatedCount = tasks.filter((t) => t.status === 'completed').length;
          const estimatedCost = tasks.length * (stage === 'shots' ? videoCost : imageCost) + (stage === 'assets' ? ensuredMainCount * imageCost : 0);
          return compactNulls({
            ok: blockers.length === 0,
            runId,
            stage: blockers.length ? 'BLOCKED' : stage === 'shots' ? 'SHOTS_DONE' : 'ASSETS_DONE',
            generatedCount,
            syncedCount,
            healedCount,
            confirmedCount,
            estimatedCost,
            message,
            tasks,
            blockers,
            refIssues,
            durations: durationPlan,
            durationWarnings,
          });
        },
})
}
