import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { missingAssetTemplates, missingAssetRatios, resolveAssetTemplateForAsset, styleWikiIdFromMetadata, ratioKeyFor } from '../story/templates.js';
import { projectSettingsReady } from '../story/analysis.js';
import { ensureAssetMainImage } from '../story/ensure-main.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { findToolBySlug, submitVariantGenerate, waitTaskStatuses, syncGeneratedResult } from '../story/client.js';
import { buildVariantGenerateBody } from '../story/prompt.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_asset_add',
    description: '补建剧本/分镜需要但分析漏掉的资产：建资产 → 建变体（可选生成参考图）→ 回写；是否生成由调用方决定，之后用 shotfix 把新变体标签加进分镜。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      assetType: { type: 'string', description: 'character / scene / item / creature' },
      name: { type: 'string', description: '资产正名（如 陈默、恋爱合作协议）' },
      description: { type: 'string', description: '资产描述/外观' },
      variantName: { type: 'string', description: '变体名（默认「默认造型」）' },
      prompt: { type: 'string', description: '变体生成提示词（默认用 description）' },
      negativePrompt: { type: 'string', description: '负向提示词（可空）' },
      generate: { type: 'boolean', description: '是否立即生成参考图（默认 false；显式传 true 才花钱）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          assetId: { type: 'string' },
          variantId: { type: 'string' },
          taskId: { type: 'string' },
          status: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`asset_add ${value.runId}: ${value.ok ? '已补建' : '失败'}`];
        if (value.assetId) lines.push(`- 资产: ${value.assetId}`);
        if (value.variantId) lines.push(`- 变体: ${value.variantId}（${value.status}）`);
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
      if (state && token && args?.generate === true) {
        const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
        projectMetadata = proj.json?.data?.metadata || {};
    if (!projectSettingsReady(projectMetadata)) blockers.push('请先到任务列表打开项目设置并保存，完成项目设置后再补建资产');
        const missing = missingAssetTemplates(projectMetadata);
        if (missing.length) blockers.push(`资产模板未选（${missing.join(', ')}）；先 myreels_templates 列出并让用户选择`);
        const missingRatio = missingAssetRatios(projectMetadata);
        if (missingRatio.length) blockers.push(`资产比例未设（${missingRatio.join(', ')}）；先 myreels_templates set 自动写入推荐比例`);
      }
      const assetType = String(args?.assetType || 'item');
      const name = String(args?.name || '').trim();
      if (!name) blockers.push('缺少资产名');
      let assetId = '';
      let variantId = '';
      let taskId = '';
      let status = '';

      if (state && token && !blockers.length) {
        const assetBody = {
          assetType,
          name,
          description: String(args?.description || ''),
          aliasNames: [],
          metadata: { source: 'dsh-agent', addedAt: new Date().toISOString() },
        };
        const created = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets`, { method: 'POST', token, body: assetBody });
        assetId = String(created.json?.data?.id || '');
        if (!assetId) blockers.push(`建资产失败（${created.status}）`);
        let mainReference = '';
        if (assetId && args?.generate === true) {
          const mainTool = await findToolBySlug(base, token, cfg.imageModelSlug);
          const ensured = await ensureAssetMainImage({
            base,
            token,
            asset: { id: assetId, assetType, name, description: String(args?.description || '') },
            metadata: projectMetadata,
            tool: mainTool,
            state,
          });
          mainReference = ensured.url || '';
          if (!mainReference) blockers.push(`主图生成失败，已阻止变体生成：${ensured.blocker || '未知原因'}`);
        }
        if (assetId) {
          const variant = await httpJson(`${base}/api/v1/story-assets/${assetId}/variants`, {
            method: 'POST',
            token,
            body: {
              variantType: assetType === 'character' ? 'costume' : 'default',
              name: String(args?.variantName || '默认造型'),
              description: String(args?.description || ''),
              prompt: String(args?.prompt || args?.description || ''),
              negativePrompt: String(args?.negativePrompt || ''),
            },
          });
          variantId = String(variant.json?.data?.id || '');
          if (!variantId) blockers.push(`建变体失败（${variant.status}）`);
        }
      }

      if (variantId && token && args?.generate === true && !blockers.length) {
        const tool = await findToolBySlug(base, token, cfg.imageModelSlug);
        if (!tool) blockers.push(`图片模型不存在：${cfg.imageModelSlug}`);
        const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
        const template = await resolveAssetTemplateForAsset(base, token, { name, description: String(args?.description || '') }, assetType, proj.json?.data?.metadata, '', true);
        const templateId = template.id;
        if (!templateId) blockers.push(`找不到 ${assetType} 的模板 id，请重新选择模板`);
        if (tool && templateId) {
          const ratio = String(projectMetadata[ratioKeyFor(assetType)] || state.settings?.aspect || '9:16');
          const styleWikiId = styleWikiIdFromMetadata(projectMetadata);
          const body = buildVariantGenerateBody(tool, { aspect: ratio, assetType, templateId, styleWikiId, referenceImage: mainReference });
          const sub = await submitVariantGenerate(base, token, variantId, body);
          taskId = sub.taskId;
          if (!taskId) blockers.push(`提交生成失败（${sub.status}）`);
          if (taskId) {
            const statuses = await waitTaskStatuses(base, token, [taskId], { intervalMs: 15000, maxRounds: 80 });
            status = statuses.get(taskId) || 'unknown';
            if (status !== 'completed') blockers.push(`图片任务未完成：${status}`);
            if (status === 'completed') {
              const common = {
                storyProjectId: state.projectId,
                ...(state.canvasProjectId ? { canvasProjectId: Number(state.canvasProjectId) } : {}),
                ...(state.groupId ? { canvasProjectGroupId: Number(state.groupId) } : {}),
                taskId,
              };
              await syncGeneratedResult(base, token, { ...common, targetType: 'asset_variant', variantId, assetId });
            }
          }
        }
      }
      return compactNulls({ ok: blockers.length === 0, runId, assetId, variantId, taskId, status, blockers });
    },
  });
}
