import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { writeRunState } from '../core/state.js';
import { resolveOwner, ownerFields, localProjectVisible } from '../core/owner.js';
import { compactNulls, parseEpisodeNo } from '../core/util.js';
import { normalizeRatios } from '../story/prompt.js';
import { analysisReviewMode, analysisSettingsFromMetadata, analysisSettingsText, needsAnalysisConfirmation } from '../story/analysis.js';
import { ensureGroup, ensureStoryProjectForGroup, putProjectMetadata, ensureCanvas, createEpisode, createScript, submitAnalyze } from '../story/client.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_run_start',
        description:
          '创建/复用画布组与故事项目。新建项目必须先返回 confirmationQuestion，调用方必须用 ask_user_question 让用户确认项目名称后才可用 confirmProjectName=true 重试；创建后停在 SETTINGS_PENDING，必须用 settingsQuestion 让用户去任务列表完成项目设置。返回 runId 与 state 路径。',
        parameters: {
          script: { type: 'string', description: '剧本全文（与 scriptPath 二选一）' },
          scriptPath: { type: 'string', description: '剧本文件路径' },
          title: { type: 'string', description: '剧名（新建项目前必须由用户确认）' },
          projectId: { type: 'string', description: '复用已有项目（可空）' },
          confirmProjectName: { type: 'boolean', description: '用户已确认项目名称时传 true；新建项目不传则不会创建' },
          groupId: { type: 'number', description: '复用已有画布组（可空）' },
          aspect: { type: 'string', description: '9:16 / 16:9 / 1:1' },
          styleText: { type: 'string', description: '画风文本' },
          stylePageId: { type: 'string', description: '画风 wiki pageId' },
          budgetPoints: { type: 'number', description: '预算点数' },
          episodeStart: { type: 'number', description: '起始集号（默认从剧本解析）' },
          episodeEnd: { type: 'number', description: '结束集号' },
          assetReview: { type: 'string', description: 'manual / auto / off（默认 manual，生成资产前需人工确认）' },
          imageModel: { type: 'string', description: '图片模型显示名（可空=config）' },
          imageModelSlug: { type: 'string', description: '图片模型 slug（可空=config）' },
          videoModelSlug: { type: 'string', description: '视频模型 slug（可空=config）' },
          scriptProcessingMode: { type: 'string', description: 'script_standard / director_storyboard / novel_faithful' },
          analysisReview: { type: 'string', description: 'manual / auto（默认 manual，分析前需用户确认）' },
          confirmAnalysis: { type: 'boolean', description: '用户已确认分析参数时传 true；manual 模式下不传则只建剧本不提交分析' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              projectId: { type: 'string' },
              groupId: { type: 'number' },
              episodeId: { type: 'string' },
              scriptId: { type: 'string' },
              episodeNo: { type: 'number' },
              taskId: { type: 'string' },
              analyzeStatus: { type: 'string' },
              analysisPending: { type: 'boolean' },
              analysisReview: { type: 'string' },
              analysisSettings: { type: 'string' },
              needsProjectNameConfirmation: { type: 'boolean' },
              proposedTitle: { type: 'string' },
              settingsPending: { type: 'boolean' },
              settingsUrl: { type: 'string' },
              confirmationQuestion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  header: { type: 'string' },
                  question: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                    },
                  },
                },
              },
              settingsQuestion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  header: { type: 'string' },
                  question: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                    },
                  },
                },
              },
              statePath: { type: 'string' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(value.ok ? 'MyReels run 已创建' : 'MyReels run 创建失败');
            if (value.runId) lines.push(`- runId: ${value.runId}`);
            if (value.projectId) lines.push(`- projectId: ${value.projectId}`);
            if (value.groupId) lines.push(`- groupId: ${value.groupId}`);
            if (value.episodeNo) lines.push(`- 集: 第 ${value.episodeNo} 集`);
            if (value.taskId) lines.push(`- 分析任务: ${value.taskId} (${value.analyzeStatus || 'submitted'})`);
            if (value.analysisPending) {
              lines.push('- 分析: 等待用户确认，尚未提交');
              if (value.analysisSettings) lines.push(`- 参数: ${value.analysisSettings}`);
            }
            if (value.confirmationQuestion) {
              lines.push(`- 需要提问确认: ${value.confirmationQuestion.question}`);
              for (const option of value.confirmationQuestion.options || []) lines.push(`  · ${option.label}`);
            }
            if (value.settingsPending) {
              lines.push('- 项目设置: 请先到任务列表完成项目设置，保存后再确认分析');
              if (value.settingsUrl) lines.push(`- 设置入口: ${value.settingsUrl}`);
            }
            if (value.settingsQuestion) {
              lines.push(`- 需要提问确认: ${value.settingsQuestion.question}`);
              for (const option of value.settingsQuestion.options || []) lines.push(`  · ${option.label}`);
            }
            if (value.statePath) lines.push(`- state: ${value.statePath}`);
            if (value.blockers?.length) {
              lines.push('阻塞项：');
              for (const b of value.blockers) lines.push(`  · ${b}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const input = args || {};
          const blockers = [];
          const runId = randomUUID();

          const token = await loginToken(base, creds);
          const owner = await resolveOwner(base, token);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          let text = String(input.script || '');
          if (!text && input.scriptPath) {
            try {
              text = readFileSync(String(input.scriptPath), 'utf8');
            } catch {
              blockers.push(`剧本文件不可读：${input.scriptPath}`);
            }
          }
          if (!text.trim()) blockers.push('缺少剧本（script 或 scriptPath）');

          const title = String(input.title || '未命名短剧');
          const mode = String(input.scriptProcessingMode || 'script_standard');
          let styleText = String(input.styleText || '');
          let stylePageId = String(input.stylePageId || '');
          const episodeNo = Number(input.episodeStart || parseEpisodeNo(text));
          const episodeEnd = Number(input.episodeEnd || episodeNo);
          if (!Number.isInteger(episodeNo) || episodeNo <= 0) blockers.push('剧本分析只支持单集：无法确定起始集号');
          if (Number.isInteger(episodeEnd) && episodeEnd !== episodeNo) blockers.push('剧本分析只支持单集，请勿使用 1-x 集范围；多集请用 episode_batch 并行提交多个单集');
          let aspect = String(input.aspect || '');
          let budgetPoints = Number(input.budgetPoints || 0);
          const assetReview = String(input.assetReview || 'manual');
          let analysisReview = String(input.analysisReview || 'manual');
          let analysisMeta = {};
          const imageModel = String(input.imageModel || configOf(config).imageModel || '');
          let imageModelSlug = String(input.imageModelSlug || configOf(config).imageModelSlug || '');
          let videoModelSlug = String(input.videoModelSlug || configOf(config).videoModelSlug || '');

          let projectId = String(input.projectId || '');
          let groupId = Number(input.groupId || 0);
          let project = null;
          const isNewProject = !projectId;

          if (isNewProject) {
            if (!String(input.title || '').trim()) blockers.push('新建项目前需要先让用户确认项目名称');
            if (input.confirmProjectName !== true) {
              return compactNulls({
                ok: false,
                needsProjectNameConfirmation: true,
                proposedTitle: title,
                confirmationQuestion: {
                  header: '确认项目名称',
                  question: `即将创建项目「${title}」。请确认项目名称是否正确？`,
                  options: [
                    { label: '确认名称并创建', description: '使用该名称创建画布组、故事项目和剧本' },
                    { label: '修改名称', description: '返回并告诉我新的项目名称' },
                    { label: '取消', description: '暂不创建项目' },
                  ],
                },
                blockers,
              });
            }
          }

          if (!blockers.length) {
            if (projectId) {
              const gp = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
              if (gp.status === 200) project = gp.json?.data || null;
              else blockers.push(`项目不可读（${gp.status}）`);
              if (!groupId && project) {
                const g = await ensureGroup(base, token, String(project.title || title), projectId);
                groupId = g.id;
                if (!groupId) blockers.push(`建画布组失败（${g.status}）`);
              }
            } else {
              const g = await ensureGroup(base, token, title);
              groupId = g.id;
              if (!groupId) blockers.push(`建画布组失败（${g.status}）`);
              if (groupId) {
                const p = await ensureStoryProjectForGroup(base, token, groupId, title);
                projectId = p.projectId;
                if (!projectId) blockers.push(`建故事项目失败（${p.status}）`);
              }
            }
          }

          let episodeId = '';
          let scriptId = '';
          let taskId = '';
          let analyzeStatus = '';
          let statePath = '';
          let settingsPending = isNewProject;

          if (!blockers.length && projectId) {
            const fresh = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
            project = fresh.json?.data || project;
            const meta = project?.metadata && typeof project.metadata === 'object' ? { ...project.metadata } : {};
            if (projectId && !localProjectVisible(projectId, meta)) blockers.push('当前操作者无权访问该项目');
            analysisMeta = meta;
            if (meta.harnessSettingsRequired && !meta.harnessSettingsCompletedAt) settingsPending = true;
            analysisReview = String(input.analysisReview || meta.analysisReview || analysisReview || 'manual');
            const effectiveAspect = String(input.aspect || meta.defaultVideoRatio || aspect || '9:16');
            aspect = effectiveAspect;
            if (!input.imageModelSlug && meta.imageModelSlug) imageModelSlug = String(meta.imageModelSlug);
            if (!input.videoModelSlug && meta.videoModelSlug) videoModelSlug = String(meta.videoModelSlug);
            if (!input.budgetPoints && Number(meta.runBudgetPoints) > 0) budgetPoints = Number(meta.runBudgetPoints);
            if (!styleText) styleText = String(meta.defaultStyleWikiPrompt?.promptTemplate || '');
            if (!stylePageId) stylePageId = String((Array.isArray(meta.defaultStyleWikiPromptIds) ? meta.defaultStyleWikiPromptIds[0] : '') || '');
            const ratios = normalizeRatios(meta);
            if (input.aspect) {
              ratios.character = aspect;
              ratios.scene = aspect;
              ratios.image = aspect;
              ratios.video = aspect;
            }
            const merged = {
              ...meta,
              runId,
              source: 'dsh-agent',
              storySettingsConfigured: true,
              scriptProcessingMode: mode,
              script_processing_mode: mode,
              runBudgetPoints: budgetPoints,
              assetReview,
              analysisReview,
              harnessSettingsRequired: settingsPending || Boolean(meta.harnessSettingsRequired && !meta.harnessSettingsCompletedAt),
              harnessOwnerKey: String(owner.ownerKey || ''),
              harnessOwnerLabel: String(owner.ownerLabel || owner.username || ''),
              harnessOwnerSubaccountId: owner.ownerSubaccountId ?? null,
              imageModelSlug,
              videoModelSlug,
              defaultStyleWikiPrompt: {
                title: styleText ? '自定义画风' : String(meta.defaultStyleWikiPrompt?.title || ''),
                promptTemplate: styleText || String(meta.defaultStyleWikiPrompt?.promptTemplate || ''),
              },
              defaultStyleWikiPromptIds: stylePageId ? [Number(stylePageId)] : (meta.defaultStyleWikiPromptIds || []),
              defaultCharacterRatio: ratios.character,
              defaultSceneRatio: ratios.scene,
              defaultItemRatio: ratios.item,
              defaultCreatureRatio: ratios.creature,
              defaultImageRatio: ratios.image,
              defaultVideoRatio: ratios.video,
            };
            const put = await putProjectMetadata(base, token, projectId, merged);
            if (put.status !== 200) blockers.push(`写项目设置失败（${put.status}）`);
            if (put.status === 200) await ensureCanvas(base, token, projectId, groupId, title);

            const ep = await createEpisode(base, token, projectId, episodeNo);
            episodeId = ep.id;
            if (!episodeId) {
              const list = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes`, { token });
              const found = (list.json?.data?.items || []).find((x) => Number(x.episodeNo) === episodeNo);
              episodeId = found?.id || '';
            }
            if (!episodeId) blockers.push(`建集失败（${ep.status}）`);

            if (episodeId) {
              const sc = await createScript(base, token, episodeId, text);
              scriptId = sc.id;
              if (!scriptId) blockers.push(`建剧本失败（${sc.status}）`);
            }

            if (scriptId) {
              if (settingsPending) {
                analyzeStatus = 'settings-pending';
              } else {
                analysisReview = String(input.analysisReview || meta.analysisReview || analysisReview || 'manual');
                const pending = needsAnalysisConfirmation({ ...meta, analysisReview }, input);
                if (pending) {
                  analyzeStatus = 'pending-confirmation';
                } else {
                  const an = await submitAnalyze(base, token, scriptId, { text, stylePrompt: styleText, mode, episodeNo, analysis: analysisSettingsFromMetadata({ ...meta, analysisReview }) });
                  taskId = an.taskId;
                  analyzeStatus = an.statusText || String(an.status);
                  if (an.status !== 200 && an.status !== 201) blockers.push(`提交分析失败（${an.status}）`);
                }
              }
            }

            statePath = writeRunState(runId, {
              runId,
              projectId,
              projectTitle: String(title || ''),
              groupId,
              episodeId,
              scriptId,
              episodeNo,
              scriptText: String(text || '').slice(0, 20000),
              episodeEnd,
              taskId,
              stage: settingsPending ? 'SETTINGS_PENDING' : (analyzeStatus === 'pending-confirmation' ? 'ANALYSIS_PENDING' : 'ANALYSIS_SUBMITTED'),
              requiresSettingsConfirmation: settingsPending,
              settings: { aspect, styleText, stylePageId, budgetPoints, assetReview, analysisReview, scriptProcessingMode: mode, imageModel, imageModelSlug, videoModelSlug, analysisSettings: analysisSettingsFromMetadata(meta) },
              ...ownerFields(owner),
              createdAt: new Date().toISOString(),
            });
          }

          return compactNulls({
            ok: blockers.length === 0,
            runId,
            projectId,
            groupId,
            episodeId,
            scriptId,
            episodeNo,
            taskId,
            analyzeStatus,
            analysisPending: analyzeStatus === 'pending-confirmation',
            analysisReview: analysisReviewMode({ analysisReview }),
            analysisSettings: analysisSettingsText(analysisSettingsFromMetadata({ ...analysisMeta, analysisReview })),
            settingsPending,
            settingsUrl: settingsPending && projectId ? `/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(projectId)}` : '',
            settingsQuestion: settingsPending ? {
              header: '确认任务设置',
              question: '项目已创建。请到任务列表 → 项目设置完成所有参数设置并点击保存。任务设置是否已经完成？',
              options: [
                { label: '已完成设置，继续', description: '保存项目设置后继续确认分析' },
                { label: '稍后处理', description: '项目保持待设置状态，不提交分析' },
              ],
            } : null,
            statePath,
            blockers,
          });
        },
})
}
