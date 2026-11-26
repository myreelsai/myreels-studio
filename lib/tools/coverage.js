import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { variantHasImage } from '../story/image-state.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_coverage',
    description: '分析结果覆盖检查（免费）：资产是否都有图、哪些变体没被分镜引用、哪些分镜没有参考；只报事实，是否补资产由 Agent 判断。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          assets: { type: 'number' },
          variants: { type: 'number' },
          assetsWithoutImage: { type: 'number' },
          variantsWithoutImage: { type: 'number' },
          unusedVariants: { type: 'array', items: { type: 'string' } },
          shotsWithoutRefs: { type: 'array', items: { type: 'number' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [
          `coverage ${value.runId}: 资产 ${value.assets} / 变体 ${value.variants}（无图 ${value.variantsWithoutImage}）`,
        ];
        if (value.assetsWithoutImage) lines.push(`- 有 ${value.assetsWithoutImage} 个资产完全没有图`);
        if (value.unusedVariants.length) lines.push(`- 未被分镜引用: ${value.unusedVariants.join('、')}`);
        if (value.shotsWithoutRefs.length) lines.push(`- 没有参考图的分镜: ${value.shotsWithoutRefs.join('、')}`);
        lines.push('  → 是否漏资产由 Agent 读剧本判断；缺图可用 asset_add / assetfix 补');
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
      let assets = [];
      const variantsByAsset = new Map();
      let shots = [];
      if (state && token) {
        const res = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        assets = res.json?.data?.items || [];
        for (const asset of assets) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          variantsByAsset.set(asset.id, vs.json?.data?.items || []);
        }
        const sres = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        shots = sres.json?.data?.items || [];
      }
      const all = [...variantsByAsset.values()].flat();
      const withoutImage = all.filter((v) => !v.imageUrl);
      const allPrompt = shots.map((s) => String(s.prompt || '')).join('\n');
      const unused = all
        .filter((v) => v.name && !allPrompt.includes(String(v.name)))
        .map((v) => String(v.name))
        .slice(0, 20);
      const shotsWithoutRefs = shots.filter((s) => !/\(@[^|)]+\|/.test(String(s.prompt || ''))).map((s) => Number(s.shotNo));
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        assets: assets.length,
        variants: all.length,
        assetsWithoutImage: assets.filter((a) => !(variantsByAsset.get(a.id) || []).some((v) => v.imageUrl)).length,
        variantsWithoutImage: withoutImage.length,
        unusedVariants: unused,
        shotsWithoutRefs,
        blockers,
      });
    },
  });
}
