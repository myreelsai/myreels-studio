import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { missingAssetTemplates, missingAssetRatios, resolveAssetTemplateForAsset, stripLayoutHint, resolveLayoutHint, isVariantReferenced, styleWikiIdFromMetadata, ratioKeyFor, assetNeedsSubjectImage } from '../story/templates.js';
import { resolveAssetReferenceImage } from '../story/asset-reference.js';
import { ensureAssetMainImage } from '../story/ensure-main.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { budgetGuard } from '../decisions.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';
import { buildVariantGenerateBody } from '../story/prompt.js';
import {
  ensureCanvas,
  findToolBySlug,
  resolveUserFileIdByUrl,
  submitVariantGenerate,
  syncGeneratedResult,
  waitTaskStatuses,
} from '../story/client.js';
import { findImageTool as findConfiguredImageTool } from '../story/image-model.js';

const safe = (value) => String(value || 'x').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

async function resolveImageTool(base, token, projectMetadata, preferredSlug, state, cfg) {
  const toolsRes = await httpJson(`${base}/api/v1/tools?limit=500`, { token });
  const configured = findConfiguredImageTool(
    toolsRes.json?.data?.items || [],
    projectMetadata,
    preferredSlug,
  );
  if (configured) return configured;
  const fallbackSlug = String(
    preferredSlug
      || projectMetadata?.imageModelSlug
      || state?.settings?.imageModelSlug
      || cfg?.imageModelSlug
      || '',
  );
  return fallbackSlug ? findToolBySlug(base, token, fallbackSlug) : null;
}

async function waitForVariantNewImage(base, token, assetId, variantId, previousUrl, { rounds = 10, intervalMs = 3000 } = {}) {
  let lastUrl = '';
  for (let round = 0; round < rounds; round += 1) {
    const vs = await httpJson(`${base}/api/v1/story-assets/${assetId}/variants`, { token });
    const fresh = (vs.json?.data?.items || []).find((v) => v.id === variantId);
    lastUrl = String(fresh?.imageUrl || '');
    if (lastUrl && lastUrl !== previousUrl) return { url: lastUrl, variant: fresh };
    if (round < rounds - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { url: lastUrl, variant: null };
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_assetfix',
    description: '资产修复：改写变体 prompt/negativePrompt → 重新生成 → 回写；或直接确认该变体。角色优先使用。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      assetName: { type: 'string', description: '资产名（精确匹配，可空但需给 variantId）' },
      variantName: { type: 'string', description: '变体名（精确匹配，可空但需给 variantId）' },
      variantId: { type: 'string', description: '变体 id（可空；给了就不必查名字）' },
      promptPatch: { type: 'string', description: '要写入的提示词补丁（追加或替换）' },
      promptMode: { type: 'string', description: 'append（默认）/ replace' },
      negativePrompt: { type: 'string', description: '负向提示词（可空=保留原值）' },
      regenerate: { type: 'boolean', description: '改词后是否重新生成（默认 true；纯改词/确认时传 false）' },
      confirm: { type: 'boolean', description: '是否把该变体标记为已确认（默认 false）' },
      modelName: { type: 'string', description: '图片模型（默认 config.imageModel）' },
      layout: { type: 'string', description: '布局：none（默认，不改写提示词）/ template（显式按模板布局追加，需 Harness 明确选择）' },
      templateSlug: { type: 'string', description: '按资产切换模板（可空；如群体像 wiki-page-mswpb6uh）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          assetName: { type: 'string' },
          variantName: { type: 'string' },
          variantId: { type: 'string' },
          promptUpdated: { type: 'boolean' },
          regenerated: { type: 'boolean' },
          confirmed: { type: 'boolean' },
          taskId: { type: 'string' },
          imagePath: { type: 'string' },
          estimatedCost: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`assetfix ${value.assetName || ''} / ${value.variantName || value.variantId || ''}`];
        lines.push(`- prompt 更新: ${value.promptUpdated ? '是' : '否'} / 重生成: ${value.regenerated ? '是' : '否'} / 确认: ${value.confirmed ? '是' : '否'}`);
        if (value.estimatedCost) lines.push(`- 预估消耗: ${value.estimatedCost} 点`);
        if (value.imagePath) lines.push(`- 新图: ${value.imagePath}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      let projectMetadata = {};
      let episodeShots = [];
      if (state && token) {
        const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
        projectMetadata = proj.json?.data?.metadata || {};
        const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        episodeShots = shotsRes.json?.data?.items || [];
        const missing = missingAssetTemplates(projectMetadata);
        if (missing.length) blockers.push(`资产模板未选（${missing.join(', ')}）；先 myreels_templates 列出并让用户选择`);
        const missingRatio = missingAssetRatios(projectMetadata);
        if (missingRatio.length) blockers.push(`资产比例未设（${missingRatio.join(', ')}）；先 myreels_templates set 自动写入推荐比例`);
      }

      let asset = null;
      let variant = null;
      let promptUpdated = false;
      let regenerated = false;
      let confirmed = false;
      let taskId = '';
      let imagePath = '';
      let estimatedCost = 0;
      let mainCost = 0;
      const promptPatch = String(args?.promptPatch || '');
      const promptMode = String(args?.promptMode || 'append') === 'replace' ? 'replace' : 'append';
      const shouldRegenerate = promptPatch ? args?.regenerate !== false : args?.regenerate === true;

      if (state && token && !blockers.length) {
        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assets = assetsRes.json?.data?.items || [];
        const byId = String(args?.variantId || '');
        const byName = String(args?.assetName || '');
        const byVariant = String(args?.variantName || '');
        for (const candidate of assets) {
          if (byName && candidate.name !== byName) continue;
          const vs = await httpJson(`${base}/api/v1/story-assets/${candidate.id}/variants`, { token });
          const found = (vs.json?.data?.items || []).find((v) => (byId ? v.id === byId : v.name === byVariant));
          if (found) {
            asset = candidate;
            variant = found;
            break;
          }
        }
        if (!variant) blockers.push('找不到目标变体（检查 assetName / variantName / variantId）');
        if (variant && asset && shouldRegenerate && assetNeedsSubjectImage(asset.assetType) && !String(asset.referenceImageUrl || '').trim()) {
          const ensureTool = await resolveImageTool(base, token, projectMetadata, '', state, cfg);
          const ensured = await ensureAssetMainImage({
            base,
            token,
            asset,
            metadata: projectMetadata,
            tool: ensureTool,
            state,
          });
          if (ensured.url) {
            asset.referenceImageUrl = ensured.url;
            if (!ensured.fallback) mainCost = cfg.unitCost.image;
          } else blockers.push(`主图生成失败，已阻止变体生成：${ensured.blocker || '未知原因'}`);
        }
      }

      if (variant && token && !blockers.length) {
        if (args?.confirm === true) {
          const meta = variant.metadata && typeof variant.metadata === 'object' ? variant.metadata : {};
          const rc = await httpJson(`${base}/api/v1/story-asset-variants/${variant.id}`, {
            method: 'POST',
            token,
            body: { metadata: { ...meta, confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: 'agent' } },
          });
          if (rc.status === 200) confirmed = true;
          else blockers.push(`确认失败（${rc.status}）`);
        }

        if (promptPatch) {
          const useDescription = !variant.prompt && !!variant.description;
          const current = String(useDescription ? variant.description : variant.prompt || '');
          const nextPrompt = promptMode === 'replace' ? promptPatch : `${current}\n\n${promptPatch}`.trim();
          const body = useDescription ? { description: nextPrompt } : { prompt: nextPrompt };
          if (args?.negativePrompt !== undefined) body.negativePrompt = String(args.negativePrompt || '');
          const upd = await httpJson(`${base}/api/v1/story-asset-variants/${variant.id}`, { method: 'POST', token, body });
          if (upd.status === 200) promptUpdated = true;
          else blockers.push(`更新提示词失败（${upd.status}）`);
        }

        if (shouldRegenerate && !blockers.length) {
          const imageSlug = String(
            args?.imageModelSlug
              || projectMetadata?.imageModelSlug
              || state.settings?.imageModelSlug
              || cfg.imageModelSlug
              || '',
          );
          const modelName = String(args?.modelName || projectMetadata?.imageName || state.settings?.imageModel || cfg.imageModel);
          const tool = await resolveImageTool(base, token, projectMetadata, args?.imageModelSlug || '', state, cfg);
          const unitCost = Number(tool?.estimatedCost) || cfg.unitCost.image;
          const budget = Number(projectMetadata.runBudgetPoints ?? state.settings?.budgetPoints ?? 0);
          const guard = budgetGuard({ budget, spent: Number(state.spentPoints || 0), nextCost: unitCost + mainCost });
          if (!guard.allow) blockers.push(guard.reason);
          if (!guard.allow) {
            /* blocked before spending */
          } else {
            if (!tool) {
              blockers.push(`模型工具不存在：${imageSlug || modelName}`);
            } else {
              const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
              const template = await resolveAssetTemplateForAsset(base, token, asset, asset?.assetType, proj.json?.data?.metadata, String(args?.templateSlug || ''), true);
              const templateId = template.id;
              if (!templateId) blockers.push(`找不到 ${asset?.assetType} 的模板 id，请重新选择模板`);
              const layoutMode = String(args?.layout || 'none');
              const hint = resolveLayoutHint(
                template.title,
                layoutMode,
                isVariantReferenced(episodeShots, variant.name),
              );
              const currentPrompt = String(variant.prompt || variant.description || '');
              const basePrompt = layoutMode === 'none' ? currentPrompt : stripLayoutHint(currentPrompt);
              const patched = hint ? `${basePrompt}\n\n${hint}`.trim() : basePrompt;
              if (templateId && patched !== currentPrompt.trim()) {
                await httpJson(`${base}/api/v1/story-asset-variants/${variant.id}`, {
                  method: 'POST',
                  token,
                  body: { prompt: patched },
                });
                variant.prompt = patched;
              }
              const ratio = String(projectMetadata[ratioKeyFor(asset?.assetType)] || state.settings?.aspect || '9:16');
              const styleWikiId = styleWikiIdFromMetadata(projectMetadata);
              const referenceImage = assetNeedsSubjectImage(asset?.assetType) ? await resolveAssetReferenceImage(base, token, asset) : '';
              const previousUrl = String(variant.imageUrl || '');
              const body = templateId
                ? buildVariantGenerateBody(tool, {
                    aspect: ratio,
                    assetType: String(asset?.assetType || ''),
                    templateId,
                    styleWikiId,
                    referenceImage,
                  })
                : null;
              const sub = body ? await submitVariantGenerate(base, token, variant.id, body) : { status: 0, taskId: '' };
              if (!sub.taskId) {
                blockers.push(`提交失败（${sub.status}）`);
              } else {
                estimatedCost = unitCost + mainCost;
                taskId = sub.taskId;
                const statuses = await waitTaskStatuses(base, token, [taskId], { intervalMs: 15000, maxRounds: 40 });
                if (statuses.get(taskId) !== 'completed') {
                  blockers.push(`生成未完成（${statuses.get(taskId) || 'unknown'}）`);
                } else {
                  const { url } = await waitForVariantNewImage(
                    base,
                    token,
                    variant.assetId || asset?.id,
                    variant.id,
                    previousUrl,
                  );
                  if (!url || (previousUrl && url === previousUrl)) {
                    blockers.push('生成完成但变体没有图');
                  } else {
                    const canvasProjectId = await ensureCanvas(base, token, state.projectId, state.groupId, '');
                    const userFileId = await resolveUserFileIdByUrl(base, token, url, taskId);
                    const common = {
                      storyProjectId: state.projectId,
                      ...(canvasProjectId ? { canvasProjectId } : {}),
                      ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                      url,
                      ...(userFileId ? { userFileId } : {}),
                      taskId,
                    };
                    await syncGeneratedResult(base, token, { ...common, targetType: 'asset_variant', variantId: variant.id, assetId: variant.assetId });
                    regenerated = true;
                    if (userFileId) {
                      const dl = await httpJson(`${base}/api/v1/user-files/download/${userFileId}`, { token });
                      const signed = typeof dl.json?.data === 'string' ? dl.json.data : '';
                      if (signed) {
                        const buf = await fetchBinary(signed);
                        if (buf) {
                          const dir = layoutOfState(state)?.assetsDir || join(runsRoot(), '.checks', runId);
                          mkdirSync(dir, { recursive: true });
                          imagePath = join(dir, `fixed-${safe(asset?.name)}-${safe(variant.name)}.png`);
                          writeFileSync(imagePath, buf);
                        }
                      }
                    }
                    writeRunState(runId, {
                      ...state,
                      ...(promptUpdated ? { assetPromptsConfirmed: false, assetPromptsConfirmedAt: null } : {}),
                      spentPoints: Number(state.spentPoints || 0) + unitCost + mainCost,
                      lastAdvanceAt: new Date().toISOString(),
                    });
                  }
                }
              }
            }
          }
        }
      }

      return compactNulls({
        ok: blockers.length === 0,
        runId,
        assetName: String(asset?.name || ''),
        variantName: String(variant?.name || ''),
        variantId: String(variant?.id || ''),
        promptUpdated,
        regenerated,
        confirmed,
        taskId,
        imagePath,
        estimatedCost,
        blockers,
      });
    },
  });
}
