import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { inspectVariant, hasBlockingIssues } from '../story/assetqc.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';
import { probeImage, timeWords, layoutWords } from '../story/image-facts.js';
import { isVariantReferenced } from '../story/templates.js';

const safe = (value) => String(value || 'x').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

export default function createTool(config) {
  return defineTool({
    name: 'myreels_assetcheck',
    description: '资产一致性检查（免费）：把每个变体的图/提示词/关键信息整理成检查包，角色优先；供视觉模型逐张判定。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      assetType: { type: 'string', description: '只看某类资产（character/scene/item/creature，可空=全部）' },
      limit: { type: 'number', description: '最多检查多少个变体（默认 30）' },
      downloadImages: { type: 'boolean', description: '是否把图下载到本地供视觉读取（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                assetType: { type: 'string' },
                assetName: { type: 'string' },
                variantName: { type: 'string' },
                variantId: { type: 'string' },
                prompt: { type: 'string' },
                imagePath: { type: 'string' },
                imageWidth: { type: 'number' },
                imageHeight: { type: 'number' },
                aspect: { type: 'string' },
                meanLuminance: { type: 'number' },
                timeWords: { type: 'array', items: { type: 'string' } },
                layoutWords: { type: 'array', items: { type: 'string' } },
                referencedByShots: { type: 'boolean' },
                duplicateName: { type: 'boolean' },
                confirmed: { type: 'boolean' },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      code: { type: 'string' },
                      level: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const characters = value.variants.filter((v) => v.assetType === 'character');
        const others = value.variants.filter((v) => v.assetType !== 'character');
        const lines = [`assetcheck ${value.runId}: ${value.variants.length} 个变体（角色 ${characters.length}，优先）`];
        if (characters.length) {
          lines.push('角色（重点检查）：');
          for (const v of characters) {
            const tag = v.confirmed ? '已确认' : '未确认';
            const facts = [
              v.aspect ? `比例 ${v.aspect}` : '',
              v.meanLuminance !== null && v.meanLuminance !== undefined ? `亮度 ${v.meanLuminance}` : '',
              v.timeWords?.length ? `时间词 ${v.timeWords.join('/')}` : '',
              v.layoutWords?.length ? `布局 ${v.layoutWords.join('/')}` : '',
              v.referencedByShots ? '被分镜引用' : '未被分镜引用',
              v.duplicateName ? '重名变体' : '',
            ].filter(Boolean).join('，');
            lines.push(`  · ${v.assetName} / ${v.variantName}（${tag}）${facts ? `[${facts}]` : ''}${v.imagePath ? ` → ${v.imagePath}` : ''}`);
            for (const issue of v.issues) lines.push(`      - ${issue.level}: ${issue.message}`);
          }
        }
        if (others.length) lines.push(`其他资产：${others.map((v) => `${v.assetType}:${v.assetName}/${v.variantName}`).join('；')}`);
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
      const limit = Math.max(1, Number(args?.limit || 30));
      const onlyType = String(args?.assetType || '');
      const download = args?.downloadImages !== false;
      const dir = layoutOfState(state)?.assetsDir || join(runsRoot(), '.checks', runId);
      const variants = [];

      if (state && token && !blockers.length) {
        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assets = assetsRes.json?.data?.items || [];
        const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const episodeShots = shotsRes.json?.data?.items || [];
        const nameCount = new Map();
        for (const asset of assets) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          for (const variant of vs.json?.data?.items || []) {
            const key = `${asset.id}\u0000${String(variant.name || '')}`;
            nameCount.set(key, (nameCount.get(key) || 0) + 1);
          }
        }
        for (const asset of assets) {
          if (onlyType && asset.assetType !== onlyType) continue;
          if (variants.length >= limit) break;
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          for (const variant of vs.json?.data?.items || []) {
            if (variants.length >= limit) break;
            const issues = inspectVariant(asset, variant);
            let imagePath = '';
            if (download && variant.userFileId) {
              const dl = await httpJson(`${base}/api/v1/user-files/download/${variant.userFileId}`, { token });
              const url = typeof dl.json?.data === 'string' ? dl.json.data : '';
              if (url) {
                const buf = await fetchBinary(url);
                if (buf) {
                  mkdirSync(dir, { recursive: true });
                  imagePath = join(dir, `${safe(asset.name)}-${safe(variant.name)}.png`);
                  writeFileSync(imagePath, buf);
                }
              }
            }
            const facts = imagePath ? probeImage(imagePath) : { imageWidth: 0, imageHeight: 0, aspect: '', meanLuminance: 0 };
            const text = `${variant.name || ''} ${asset.name || ''} ${variant.prompt || ''} ${variant.description || ''}`;
            variants.push({
              assetType: String(asset.assetType || ''),
              assetName: String(asset.name || ''),
              variantName: String(variant.name || ''),
              variantId: String(variant.id || ''),
              prompt: String(variant.prompt || variant.description || ''),
              imagePath,
              imageWidth: facts.imageWidth,
              imageHeight: facts.imageHeight,
              aspect: facts.aspect,
              meanLuminance: facts.meanLuminance,
              timeWords: timeWords(text),
              layoutWords: layoutWords(text),
              referencedByShots: isVariantReferenced(episodeShots, variant.name),
              duplicateName: (nameCount.get(`${asset.id}\u0000${String(variant.name || '')}`) || 0) > 1,
              confirmed: variant.metadata?.confirmed === true,
              issues,
            });
          }
        }
      }

      variants.sort((a, b) => (a.assetType === 'character' ? 0 : 1) - (b.assetType === 'character' ? 0 : 1));
      const blocking = variants.filter((v) => hasBlockingIssues(v.issues)).length;
      return compactNulls({ ok: blockers.length === 0 && blocking === 0, runId, variants, blockers });
    },
  });
}
