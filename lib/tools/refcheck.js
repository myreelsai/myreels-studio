import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { buildRefIndex, resolveRefTags, findClosestVariant } from '../story/refs.js';

const SUGGEST = {
  'variant-no-image': '该变体没有图：先补生成这个变体，再跑分镜',
  'asset-no-image': '资产没有任何有图变体：先生成资产图',
  'asset-fallback': '标签匹配不到变体，将退化为资产首图（可能错图）：建议按剧本核对变体名',
  missing: '资产/变体不存在：按剧本核对该标签指向的角色/场景/物品',
};

export default function createTool(config) {
  return defineTool({
    name: 'myreels_refcheck',
    description: '检查分镜提示词里的参考图标签（(@变体 | 资产)）是否指向有图的正确变体；并检查同一场景相邻分镜的变体是否连续。不生成、不扣点。',
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
          shots: { type: 'number' },
          tags: { type: 'number' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                shotNo: { type: 'number' },
                variant: { type: 'string' },
                asset: { type: 'string' },
                status: { type: 'string' },
                suggestion: { type: 'string' },
                patch: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`refcheck ${value.runId}: ${value.shots} 镜 / ${value.tags} 个标签 / ${value.issues.length} 个问题`];
        for (const issue of value.issues.slice(0, 20)) {
          lines.push(`  · 分镜 ${issue.shotNo}: (@${issue.variant} | ${issue.asset}) — ${issue.status}；${issue.suggestion}`);
          if (issue.patch) lines.push(`    补丁：${issue.patch}`);
        }
        if (value.issues.length > 20) lines.push(`  · 其余 ${value.issues.length - 20} 条省略`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const creds = credentialsOf(cfg);
      const runId = String(args?.runId || '');
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, creds);
      if (!token) blockers.push('缺少或无效的登录凭证');
      const issues = [];
      let shots = 0;
      let tags = 0;

      if (state && token && !blockers.length) {
        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assets = assetsRes.json?.data?.items || [];
        const variantsByAsset = new Map();
        for (const asset of assets) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          variantsByAsset.set(asset.id, (vs.json?.data?.items || []).map((v) => ({
            ...v,
            imageUrl: v.imageUrl || (v.userFileId ? `user-file:${v.userFileId}` : ''),
          })));
        }
        const characterAssets = new Set(assets
          .filter((asset) => /character|角色|人物/i.test(String(asset.assetType || asset.type || '')))
          .map((asset) => String(asset.name || '')));
        const index = buildRefIndex(assets, variantsByAsset);
        const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const shotList = [...(shotsRes.json?.data?.items || [])].sort((a, b) => (Number(a.shotNo) || 0) - (Number(b.shotNo) || 0));
        let previousShot = null;
        let previousByAsset = new Map();
        const sceneKey = (shot) => String(shot?.metadata?.sceneNo ?? shot?.metadata?.scene_no ?? shot?.metadata?.sceneId ?? shot?.metadata?.scene_id ?? '');

        for (const shot of shotList) {
          shots += 1;
          const resolved = resolveRefTags(shot.prompt || shot.description, index);
          tags += resolved.length;
          const currentByAsset = new Map();
          for (const tag of resolved) {
            if (tag.status === 'ok' && tag.assetName) currentByAsset.set(tag.assetName, tag);
          }

          const previousScene = sceneKey(previousShot);
          const currentScene = sceneKey(shot);
          const sameScene = !previousShot || !previousScene || !currentScene || previousScene === currentScene;
          if (previousShot && sameScene) {
            const promptText = String(shot.prompt || shot.description || '');
            for (const [assetName, before] of previousByAsset) {
              if (!characterAssets.has(assetName)) continue;
              if (currentByAsset.has(assetName)) continue;
              if (!before.variantName || !promptText.includes(assetName)) continue;
              issues.push({
                shotNo: Number(shot.shotNo) || 0,
                variant: before.variantName,
                asset: assetName,
                status: 'continuity-ref-missing',
                suggestion: `本镜仍出现角色「${assetName}」，但缺少参考标签；同一场景应补上一镜的 (@${before.variantName} | ${assetName})`,
                patch: `(@${before.variantName} | ${assetName})`,
              });
            }
            for (const [assetName, tag] of currentByAsset) {
              const before = previousByAsset.get(assetName);
              if (!before?.variantName || !tag.variantName || before.variantName === tag.variantName) continue;
              issues.push({
                shotNo: Number(shot.shotNo) || 0,
                variant: tag.variantName,
                asset: assetName,
                status: 'continuity-variant-change',
                suggestion: `上一镜使用 (@${before.variantName} | ${assetName})，本镜使用 (@${tag.variantName} | ${assetName})；同一场景连续分镜应保持同一套服装/造型，请确认或改回上一镜变体`,
                patch: `(@${before.variantName} | ${assetName})`,
              });
            }
          }
          previousShot = shot;
          previousByAsset = currentByAsset;

          for (const tag of resolved) {
            if (tag.status === 'ok') continue;
            let suggestion = SUGGEST[tag.status] || '需要人工确认';
            const inScript = state.scriptText ? String(state.scriptText).includes(tag.asset) : true;
            if (!inScript) suggestion = `剧本未出现「${tag.asset}」，标签可能错配；按剧本核对`;
            const closest = findClosestVariant(tag.variant, index);
            if (closest && closest.variantName && closest.variantName !== tag.variant) {
              suggestion += `；最接近的变体：(@${closest.variantName} | ${closest.assetName})`;
            }
            if (tag.status === 'variant-no-image' && tag.assetName) {
              suggestion += `；补图命令：myreels_run_advance(assets, assetName=${tag.assetName}, variantName=${tag.variant})`;
            }
            issues.push({
              shotNo: Number(shot.shotNo) || 0,
              variant: tag.variant,
              asset: tag.asset,
              status: tag.status,
              suggestion,
            });
          }
        }
      }

      return compactNulls({ ok: blockers.length === 0 && issues.length === 0, runId, shots, tags, issues, blockers });
    },
  });
}
