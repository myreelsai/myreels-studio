import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { auditAssetPrompts } from '../story/asset-audit.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_asset_audit',
    description: '生成前资产审查包（免费）：输出每个资产/变体的完整提示词、描述、参考图、分镜引用和平台硬约束问题。画面准确度由 Harness 阅读提示词/剧情/参考图后判断；审查后用 confirm=true + reviewNotes 留下结论，再生成资产。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      confirm: { type: 'boolean', description: '审查完成且无结构阻断后，标记“资产提示词已由 Harness 确认”（默认 false）' },
      reviewNotes: { type: 'string', description: '审查结论：哪些提示词改过、参考图依据、仍存风险；confirm=true 时必填' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          confirmed: { type: 'boolean' },
          reviewNotes: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assets: { type: 'number' },
              variants: { type: 'number' },
              blockers: { type: 'number' },
              warnings: { type: 'number' },
              missingReferences: { type: 'number' },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                assetId: { type: 'string' },
                assetName: { type: 'string' },
                assetType: { type: 'string' },
                assetDescription: { type: 'string' },
                variantName: { type: 'string' },
                variantType: { type: 'string' },
                prompt: { type: 'string' },
                negativePrompt: { type: 'string' },
                description: { type: 'string' },
                promptLength: { type: 'number' },
                hasImage: { type: 'boolean' },
                referenceImageUrl: { type: 'string' },
                imageUrl: { type: 'string' },
                shotRefs: { type: 'array', items: { type: 'number' } },
              },
            },
          },
        },
      },
      render(args, value) {
        const lines = [
          `asset_audit ${value.runId}: ${value.summary.assets} 资产 / ${value.summary.variants} 变体`,
          `结构阻断 ${value.summary.blockers}，提醒 ${value.summary.warnings}，缺参考 ${value.summary.missingReferences}`,
        ];
        for (const b of value.blockers) lines.push(`  ✗ ${b}`);
        for (const w of value.warnings.slice(0, 20)) lines.push(`  ! ${w}`);
        if (value.warnings.length > 20) lines.push(`  · 其余 ${value.warnings.length - 20} 条省略`);
        if (value.confirmed) lines.push(`  ✓ 已确认${value.reviewNotes ? `：${value.reviewNotes}` : ''}`);
        else if (!value.blockers.length) lines.push('  完整审查后执行 confirm=true + reviewNotes，再生成资产图。');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const state = readRunState(runId);
      const blockers = [];
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);

      let assets = [];
      const variantsByAsset = new Map();
      let shots = [];
      if (state && token && !blockers.length) {
        const res = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        if (res.status !== 200) blockers.push(`读取资产失败（${res.status}）`);
        assets = res.json?.data?.items || [];
        for (const asset of assets) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          variantsByAsset.set(asset.id, vs.json?.data?.items || []);
        }
        const sres = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        shots = sres.json?.data?.items || [];
      }

      const audit = blockers.length
        ? { ok: false, blockers, warnings: [], items: [], summary: { assets: assets.length, variants: 0, blockers: blockers.length, warnings: 0, missingReferences: 0 } }
        : auditAssetPrompts({ assets, variantsByAsset, shots });

      const reviewNotes = String(args?.reviewNotes || '').trim();
      let confirmed = false;
      if (args?.confirm === true) {
        if (!audit.ok || blockers.length) blockers.push('存在结构阻断问题，不能确认资产提示词');
        else if (!reviewNotes) blockers.push('confirm=true 需要 reviewNotes：写明已修改的提示词、参考图依据和剩余风险');
        else {
          writeRunState(runId, {
            ...state,
            assetPromptsConfirmed: true,
            assetPromptsConfirmedAt: new Date().toISOString(),
            assetPromptsReview: reviewNotes,
          });
          confirmed = true;
        }
      }

      return compactNulls({
        ok: audit.ok && blockers.length === 0,
        runId,
        confirmed,
        reviewNotes,
        blockers: [...blockers, ...(audit.blockers || [])],
        warnings: audit.warnings || [],
        summary: audit.summary,
        items: audit.items,
      });
    },
  });
}
