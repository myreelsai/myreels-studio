import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { findToolBySlug, waitTaskStatuses } from '../story/client.js';
import { resolveAssetTemplateForAsset, styleWikiIdFromMetadata, ratioKeyFor, assetNeedsSubjectImage } from '../story/templates.js';
import { assetOptimizePrompt } from '../story/prompt.js';
import { variantHasImage } from '../story/image-state.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_asset_main',
    description: '设置/清空资产主图（与变体图分离）：生成变体不再覆盖主图；set 可指定变体图，clear 清空回退。',
    parameters: {
      runId: { type: 'string', description: 'run_start / episode_add 返回的 runId' },
      assetId: { type: 'string', description: '资产 id（可空，用 assetName 查）' },
      assetName: { type: 'string', description: '资产名（精确匹配）' },
      action: { type: 'string', description: 'set / clear / ensure（generate 兼容别名，等同 ensure；逐个生成并等待）' },
      variantName: { type: 'string', description: 'set 时用哪个变体的图（可空=保留当前主图）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          assetId: { type: 'string' },
          assetName: { type: 'string' },
          action: { type: 'string' },
          referenceImageUrl: { type: 'string' },
          referenceUserFileId: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
          ensured: { type: 'array', items: { type: 'string' } },
          fallback: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`asset_main ${value.assetName || value.assetId}: ${value.ok ? 'ok' : '失败'}`];
        lines.push(`- action: ${value.action}`);
        lines.push(`- 主图: ${value.referenceImageUrl || '(空)'}`);
        if (value.ensured?.length) lines.push(`- 已生成: ${value.ensured.join('、')}`);
        if (value.fallback?.length) lines.push(`- 回退变体: ${value.fallback.join('、')}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const state = readRunState(runId);
      const blockers = [];
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      let assetId = String(args?.assetId || '');
      let assetName = String(args?.assetName || '');
      const action = String(args?.action || 'set') === 'generate' ? 'ensure' : String(args?.action || 'set');
      let referenceImageUrl = '';
      let referenceUserFileId = '';
      const taskIds = [];
      const ensured = [];
      const fallback = [];
      if (state && token && !blockers.length) {
        const assets = (await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token })).json?.data?.items || [];
        if (action === 'ensure') {
          const targets = assets.filter((x) => assetNeedsSubjectImage(x.assetType) && !String(x.referenceImageUrl || '').trim());
          if (!targets.length) blockers.push('没有缺主图的资产');
          const proj = (await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token })).json?.data || {};
          const meta = proj.metadata && typeof proj.metadata === 'object' ? proj.metadata : {};
          const styleId = styleWikiIdFromMetadata(meta);
          const tool = await findToolBySlug(base, token, state.settings?.imageModelSlug || cfg.imageModelSlug);
          if (!tool) blockers.push('图片模型不存在');
          for (const target of tool ? targets : []) {
            const type = String(target.assetType || '');
            const template = await resolveAssetTemplateForAsset(base, token, target, type, meta);
            if (!template.id) {
              blockers.push(`${target.name} 缺少 ${type} 模板，跳过`);
              continue;
            }
            const body = {
              assetType: type,
              assetIds: [target.id],
              targetScope: 'selected',
              generationTaskConfig: {
                serviceId: tool.serviceId,
                promptResourceId: tool.id,
                taskType: 'image',
                promptField: 'prompt',
                userInput: {
                  aspect_ratio: String(meta[ratioKeyFor(type)] || state.settings?.aspect || '9:16'),
                  size: '2K',
                  n: 1,
                  ...(assetOptimizePrompt(type) ? { optimizePrompt: assetOptimizePrompt(type) } : {}),
                  ...(styleId ? { prompt1WikiIds: [styleId] } : {}),
                  prompt2WikiIds: [template.id],
                },
                finalParameters: {
                  source: 'story_workbench',
                  assetType: type,
                  outputType: 'image',
                  modelId: tool.id,
                  model: tool.modelName,
                  modelName: tool.modelName,
                },
              },
            };
            const r = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets/generate-batch`, { method: 'POST', token, body });
            const taskId = r.json?.data?.items?.[0]?.taskId || '';
            if (taskId) {
              taskIds.push(String(taskId));
              await waitTaskStatuses(base, token, [String(taskId)], { intervalMs: 10000, maxRounds: 120 });
            }
            const fresh = (await httpJson(`${base}/api/v1/story-assets/${target.id}`, { token })).json?.data || {};
            if (String(fresh.referenceImageUrl || '').trim()) {
              ensured.push(String(target.name || ''));
              continue;
            }
            const vs = (await httpJson(`${base}/api/v1/story-assets/${target.id}/variants`, { token })).json?.data?.items || [];
            const chosen = vs.find((v) => variantHasImage(v));
            if (chosen) {
              const put = await httpJson(`${base}/api/v1/story-assets/${target.id}`, {
                method: 'PUT',
                token,
                body: {
                  referenceImageUrl: chosen.imageUrl || null,
                  referenceUserFileId: chosen.userFileId || null,
                },
              });
              if (put.status === 200) fallback.push(String(target.name || ''));
              else blockers.push(`${target.name} 主图回退失败（${put.status}）`);
            } else {
              blockers.push(`${target.name} 生成主图失败且无变体可回退`);
            }
          }
          return compactNulls({ ok: blockers.length === 0, action, taskIds, ensured, fallback, blockers });
        }
        if (action === 'generate') {
          const targets = assets.filter((x) => {
            if (!String(x.referenceImageUrl || '').trim()) return false;
            if (assetId) return x.id === assetId;
            if (assetName) return String(x.name) === assetName;
            return true;
          });
          if (!targets.length) blockers.push('没有缺主图的资产');
          const proj = (await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token })).json?.data || {};
          const meta = proj.metadata && typeof proj.metadata === 'object' ? proj.metadata : {};
          const styleId = styleWikiIdFromMetadata(meta);
          const tool = await findToolBySlug(base, token, state.settings?.imageModelSlug || cfg.imageModelSlug);
          if (!tool) blockers.push('图片模型不存在');
          if (tool && targets.length) {
            const byType = new Map();
            for (const asset of targets) {
              const type = String(asset.assetType || '');
              if (!byType.has(type)) byType.set(type, []);
              byType.get(type).push(asset.id);
            }
            for (const [type, ids] of byType) {
              const template = await resolveAssetTemplateForAsset(base, token, asset, type, meta);
              if (!template.id) {
                blockers.push(`${type} 模板未选，不能生成主图`);
                continue;
              }
              const body = {
                assetType: type,
                assetIds: ids,
                targetScope: 'selected',
                generationTaskConfig: {
                  serviceId: tool.serviceId,
                  promptResourceId: tool.id,
                  taskType: 'image',
                  promptField: 'prompt',
                  userInput: {
                    aspect_ratio: String(meta[ratioKeyFor(type)] || state.settings?.aspect || '9:16'),
                    size: '2K',
                    n: 1,
                    ...(styleId ? { prompt1WikiIds: [styleId] } : {}),
                    prompt2WikiIds: [template.id],
                  },
                  finalParameters: {
                    source: 'story_workbench',
                    assetType: type,
                    outputType: 'image',
                    modelId: tool.id,
                    model: tool.modelName,
                    modelName: tool.modelName,
                  },
                },
              };
              const r = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets/generate-batch`, {
                method: 'POST',
                token,
                body,
              });
              if (r.status !== 200 && r.status !== 201) {
                blockers.push(`提交主图生成失败（${r.status}）`);
                continue;
              }
              for (const item of r.json?.data?.items || []) {
                if (item.taskId) taskIds.push(String(item.taskId));
              }
            }
          }
          return compactNulls({ ok: blockers.length === 0, assetId, assetName, action, taskIds, blockers });
        }
        const asset = assetId
          ? assets.find((x) => x.id === assetId)
          : assets.find((x) => String(x.name) === assetName);
        if (!asset) blockers.push('找不到资产');
        if (asset) {
          assetId = String(asset.id);
          assetName = String(asset.name || assetName);
          if (action === 'set') {
            const variantName = String(args?.variantName || '');
            if (variantName) {
              const vs = (await httpJson(`${base}/api/v1/story-assets/${assetId}/variants`, { token })).json?.data?.items || [];
              const variant = vs.find((v) => String(v.name) === variantName);
              if (!variant) blockers.push(`找不到变体：${variantName}`);
              else {
                referenceImageUrl = String(variant.imageUrl || '');
                referenceUserFileId = String(variant.userFileId || '');
                if (!referenceImageUrl && !referenceUserFileId) blockers.push('该变体没有图');
              }
            } else {
              referenceImageUrl = String(asset.referenceImageUrl || '');
              referenceUserFileId = String(asset.referenceUserFileId || '');
            }
          }
          if (!blockers.length) {
            const put = await httpJson(`${base}/api/v1/story-assets/${assetId}`, {
              method: 'PUT',
              token,
              body: {
                referenceImageUrl: action === 'clear' ? null : (referenceImageUrl || null),
                referenceUserFileId: action === 'clear' ? null : (referenceUserFileId || null),
              },
            });
            if (put.status !== 200) blockers.push(`写主图失败（${put.status}）`);
            if (put.status === 200) {
              referenceImageUrl = String(put.json?.data?.referenceImageUrl || '');
              referenceUserFileId = String(put.json?.data?.referenceUserFileId || '');
            }
          }
        }
      }
      return compactNulls({
        ok: blockers.length === 0,
        assetId,
        assetName,
        action,
        referenceImageUrl,
        referenceUserFileId,
        blockers,
      });
    },
  });
}
