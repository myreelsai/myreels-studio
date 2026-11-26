import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';

const normalizeReview = (raw) => {
  const review = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(review.review_items)
    ? review.review_items
    : Array.isArray(review.reviewItems)
      ? review.reviewItems
      : [];
  const suggestions = Array.isArray(review.quality_suggestions)
    ? review.quality_suggestions
    : Array.isArray(review.qualitySuggestions)
      ? review.qualitySuggestions
      : [];
  return {
    review,
    items,
    suggestions,
  };
};

const prune = (value) => {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      out[key] = prune(item);
    }
    return out;
  }
  return value;
};

const itemView = (item) => prune({
  id: item?.id ? String(item.id) : undefined,
  code: item?.code ? String(item.code) : undefined,
  severity: item?.severity ? String(item.severity) : undefined,
  disposition: item?.disposition ? String(item.disposition) : undefined,
  reviewRequired: item?.review_required === true || item?.reviewRequired === true,
  title: item?.title ? String(item.title) : undefined,
  message: item?.message ? String(item.message) : undefined,
  field: item?.field ? String(item.field) : undefined,
  shotNo: Number.isFinite(Number(item?.shot_no ?? item?.shotNo)) ? Number(item?.shot_no ?? item?.shotNo) : undefined,
  blockNo: Number.isFinite(Number(item?.block_no ?? item?.blockNo)) ? Number(item?.block_no ?? item?.blockNo) : undefined,
  currentExcerpt: item?.current_excerpt ? String(item.current_excerpt) : undefined,
  suggestedAction: item?.suggested_action ? String(item.suggested_action) : undefined,
});

export default function createTool(config) {
  return defineTool({
    name: 'myreels_review_items',
    description: '读取某集的剧集审阅结果（deliveryReview.review_items / quality_suggestions）：给 Harness 提供可执行的修改项，再用 shotfix / 重新分析继续优化。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId（可空；用它定位项目与集）' },
      projectId: { type: 'string', description: '项目 id（可空；与 episodeNo 配合）' },
      episodeNo: { type: 'number', description: '集号（可空；给 runId 时可省略）' },
      episodeId: { type: 'string', description: '集 id（可空，优先级最高）' },
      includeSuggestions: { type: 'boolean', description: '是否返回 quality_suggestions（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          projectId: { type: 'string' },
          episodeId: { type: 'string' },
          episodeNo: { type: 'number' },
          readyForDelivery: { type: 'boolean' },
          deliveryStatus: { type: 'string' },
          deliveryClass: { type: 'string' },
          blockingCount: { type: 'number' },
          warningCount: { type: 'number' },
          manualReviewRequired: { type: 'boolean' },
          reviewCount: { type: 'number' },
          summary: { type: 'object', additionalProperties: true },
          reviewItems: { type: 'array', items: { type: 'object', additionalProperties: true } },
          qualitySuggestions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`review_items ${value.runId || value.projectId || ''} / EP${value.episodeNo || '?'}`];
        if (!value.ok) {
          for (const b of value.blockers || []) lines.push(`  · ${b}`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        lines.push(`  ${value.deliveryStatus || '?'} / blocking ${value.blockingCount || 0} / warning ${value.warningCount || 0} / items ${value.reviewCount || 0}`);
        for (const item of value.reviewItems || []) {
          lines.push(`  · [${item.severity || '?'}] 分镜${item.shotNo ?? '-'} 块${item.blockNo ?? '-'} ${item.title || item.code || ''}`);
          if (item.message) lines.push(`    ${item.message}`);
          if (item.suggestedAction) lines.push(`    建议：${item.suggestedAction}`);
        }
        for (const item of value.qualitySuggestions || []) {
          lines.push(`  ~ [建议] ${item.title || item.code || ''}${item.message ? `：${item.message}` : ''}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const blockers = [];
      const runId = String(args?.runId || '');
      const state = runId ? readRunState(runId) : null;
      if (runId && !state) blockers.push(`找不到 state：${runId}`);
      const projectId = String(args?.projectId || state?.projectId || '');
      const episodeNo = Number(args?.episodeNo || state?.episodeNo || 0);
      const episodeId = String(args?.episodeId || state?.episodeId || '');
      if (!projectId) blockers.push('缺少 projectId（或提供 runId）');
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      let episode = null;
      if (!blockers.length) {
        const r = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes?page=1&limit=200`, { token });
        if (r.status !== 200) blockers.push(`读取剧集失败（${r.status}）`);
        const items = Array.isArray(r.json?.data?.items) ? r.json.data.items : [];
        episode = episodeId
          ? items.find((x) => String(x.id) === episodeId)
          : items.find((x) => Number(x.episodeNo) === episodeNo);
        if (!episode) blockers.push(`找不到第 ${episodeNo || '?'} 集${episodeId ? `（${episodeId}）` : ''}`);
      }
      if (blockers.length) {
        return { ok: false, runId, projectId, episodeId, episodeNo, blockers };
      }
      const raw = episode.deliveryReview || episode.delivery_review || episode.metadata?.deliveryReview || episode.metadata?.delivery_review;
      const { review, items, suggestions } = normalizeReview(raw);
      if (!raw) blockers.push('该集还没有 deliveryReview 审阅结果（分析完成后才会生成）');
      const allItems = items.map(itemView).filter(Boolean);
      const qualitySuggestions = args?.includeSuggestions === false ? [] : suggestions.map(itemView).filter(Boolean);
      return prune(compactNulls({
        ok: blockers.length === 0,
        runId,
        projectId,
        episodeId: String(episode.id || episodeId),
        episodeNo: Number(episode.episodeNo) || episodeNo,
        readyForDelivery: review.ready_for_delivery === true || review.readyForDelivery === true,
        deliveryStatus: review.delivery_status ? String(review.delivery_status) : review.deliveryStatus ? String(review.deliveryStatus) : undefined,
        deliveryClass: review.delivery_class ? String(review.delivery_class) : review.deliveryClass ? String(review.deliveryClass) : undefined,
        blockingCount: Number(review.blocking_count ?? review.blockingCount ?? 0),
        warningCount: Number(review.warning_count ?? review.warningCount ?? 0),
        manualReviewRequired: review.manual_review_required === true || review.manualReviewRequired === true,
        reviewCount: allItems.length,
        summary: review.summary || {},
        reviewItems: allItems,
        qualitySuggestions,
        blockers,
      }));
    },
  });
}
