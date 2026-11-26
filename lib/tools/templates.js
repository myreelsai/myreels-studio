import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { compactNulls } from '../core/util.js';
import { putProjectMetadata } from '../story/client.js';
import { localProjectVisible } from '../core/owner.js';
import {
  ASSET_TEMPLATE_LABELS,
  listAssetTemplates,
  normalizeAssetType,
  ratioKeyFor,
  recommendRatio,
  findAssetTemplate,
  templateScopeLabel,
  templateKeyFor,
} from '../story/templates.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_templates',
    description: '资产模板（设置面板同源）：list 列出角色/场景/物品/生物的可选模板；set 把选中的模板 slug 写入项目 metadata。生成资产前四类模板必须已选。',
    parameters: {
      action: { type: 'string', description: 'list / set（默认 list）' },
      assetType: { type: 'string', description: 'character / scene / item / creature（list 可空=全部）' },
      slug: { type: 'string', description: 'set 时的模板 slug（来自 list）' },
      ratio: { type: 'string', description: 'set 时可选比例覆盖（9:16 / 16:9 / 3:4 / 1:1；空=按模板自动推荐）' },
      keyword: { type: 'string', description: 'list 关键词（可空）' },
      projectId: { type: 'string', description: 'set 时需要项目 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                assetType: { type: 'string' },
                assetTypeLabel: { type: 'string' },
                slug: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                recommendedRatio: { type: 'string' },
                id: { type: 'number' },
                scopes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          missing: { type: 'array', items: { type: 'string' } },
          selected: { type: 'string' },
          recommendedRatio: { type: 'string' },
          written: { type: 'boolean' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [];
        if (value.action === 'set') {
          lines.push(value.ok ? `templates: 已选择 ${value.selected}` : 'templates: 选择失败');
          lines.push(`- 推荐比例: ${value.recommendedRatio || '(无)'}`);
          lines.push(`- 写入: ${value.written ? 'yes' : 'no'}`);
          for (const b of value.blockers || []) lines.push(`  · ${b}`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        lines.push(`templates: ${(value.options || []).length} 个可选`);
        const grouped = new Map();
        for (const item of value.options || []) {
          const list = grouped.get(item.assetTypeLabel) || [];
          list.push(item);
          grouped.set(item.assetTypeLabel, list);
        }
        for (const [label, items] of grouped) {
          lines.push(`- ${label}`);
          for (const item of items.slice(0, 40)) {
            const scopeLabel = templateScopeLabel(item.scopes);
            lines.push(`  · ${item.title}（${item.slug}）${scopeLabel ? ` [${scopeLabel}]` : ''} 推荐比例 ${item.recommendedRatio}`);
          }
        }
        if ((value.missing || []).length) lines.push(`- 尚未选择: ${value.missing.join('、')}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const token = await loginToken(base, credentialsOf(cfg));
      const action = String(args?.action || 'list');
      const blockers = [];
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      if (action === 'list') {
        let options = [];
        if (token) options = await listAssetTemplates(base, token, args?.assetType, args?.keyword);
        return compactNulls({
          ok: blockers.length === 0,
          action,
          options,
          blockers,
        });
      }

      if (action === 'set') {
        const projectId = String(args?.projectId || '');
        const assetType = normalizeAssetType(args?.assetType);
        const slug = String(args?.slug || '');
        const selected = `${ASSET_TEMPLATE_LABELS[assetType] || assetType}:${slug}`;
        if (!projectId) blockers.push('缺少 projectId');
        if (!assetType) blockers.push('assetType 必须是 character/scene/item/creature');
        if (!slug) blockers.push('缺少 slug');
        let written = false;
        let recommendedRatio = '';
        if (!blockers.length && token) {
          const options = await listAssetTemplates(base, token, assetType);
          const hit = findAssetTemplate(options, slug);
          if (!hit && !/^\d+$/.test(slug)) {
            blockers.push(`模板 ${slug} 不在 ${ASSET_TEMPLATE_LABELS[assetType]} 的可选列表里`);
          } else {
            recommendedRatio = String(args?.ratio || '').trim() || hit?.recommendedRatio || recommendRatio(assetType, hit?.title || '', hit?.summary || '');
            const p = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
            const metadata = p.json?.data?.metadata && typeof p.json.data.metadata === 'object' ? p.json.data.metadata : {};
            if (!localProjectVisible(projectId, metadata)) {
              blockers.push('当前操作者无权访问该项目');
            } else {
              const merged = {
                ...metadata,
                [templateKeyFor(assetType)]: slug,
                [ratioKeyFor(assetType)]: recommendedRatio,
              };
              const put = await putProjectMetadata(base, token, projectId, merged);
              if (put.status === 200) written = true;
              else blockers.push(`写项目模板失败（${put.status}）`);
            }
          }
        }
        return compactNulls({
          ok: blockers.length === 0,
          action,
          selected,
          recommendedRatio,
          written,
          blockers,
        });
      }

      return compactNulls({ ok: false, action, blockers: [`未知 action=${action}`] });
    },
  });
}
