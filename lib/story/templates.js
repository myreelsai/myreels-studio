import { httpJson } from '../core/http.js';

export const ASSET_TEMPLATE_KEYS = {
  character: 'defaultCharacterTemplateSlug',
  scene: 'defaultSceneTemplateSlug',
  item: 'defaultItemTemplateSlug',
  creature: 'defaultCreatureTemplateSlug',
};

export const ASSET_VARIANT_TEMPLATE_KEYS = {
  character: 'defaultCharacterVariantTemplateSlug',
  scene: 'defaultSceneVariantTemplateSlug',
};

export const ASSET_RATIO_KEYS = {
  character: 'defaultCharacterRatio',
  scene: 'defaultSceneRatio',
  item: 'defaultItemRatio',
  creature: 'defaultCreatureRatio',
};

export const ASSET_TEMPLATE_LABELS = {
  character: '角色',
  scene: '场景',
  item: '物品',
  creature: '生物',
};

const DEFAULT_RATIOS = {
  character: '9:16',
  scene: '16:9',
  item: '16:9',
  creature: '16:9',
};

const TAXONOMY = {
  character: 'character',
  scene: 'scene',
  item: 'object',
  creature: 'creature',
};

export function normalizeAssetType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'object' || raw === 'prop') return 'item';
  return ASSET_TEMPLATE_KEYS[raw] ? raw : '';
}

/** 只有角色/场景有主体图；物品/生物没有主图，也不做垫图。 */
export function assetNeedsSubjectImage(assetType, variantType = '') {
  const type = normalizeAssetType(assetType);
  if (type === 'character') return true;
  if (type === 'scene') return String(variantType || '').trim().toLowerCase() !== 'panorama';
  return false;
}

export function templateKeyFor(assetType, variant = false) {
  const type = normalizeAssetType(assetType);
  if (!type) return '';
  const variantKey = ASSET_VARIANT_TEMPLATE_KEYS[type];
  return variant && variantKey ? variantKey : ASSET_TEMPLATE_KEYS[type];
}

export function ratioKeyFor(assetType) {
  return ASSET_RATIO_KEYS[normalizeAssetType(assetType)] || '';
}

export function recommendRatio(assetType, title, summary = '') {
  const type = normalizeAssetType(assetType);
  const text = `${String(title || '')} ${String(summary || '')}`.toLowerCase();
  // 先看画面格局：多视图/设定板天然适合横屏并排
  if (/四视图|三视图|五视图|多视图|多角度|多视角|设定板|角色设定|九宫格|六宫格|四宫格|立绘/.test(text)) {
    return '16:9';
  }
  if (type === 'scene') return '16:9';
  if (type === 'item' && !/多角度|多视角|设定图|多视图/.test(text)) return '1:1';
  if (/半身|头像|肖像|特写|单人照|单人像/.test(text)) return '9:16';
  if (/竖屏|竖版|竖向/.test(text)) return '9:16';
  if (/横屏|宽屏|横向|宽银幕/.test(text)) return '16:9';
  if (/9\s*[:：]\s*16/.test(text)) return '9:16';
  if (/3\s*[:：]\s*4/.test(text)) return '3:4';
  if (/1\s*[:：]\s*1|方形|正方/.test(text)) return '1:1';
  if (/16\s*[:：]\s*9/.test(text)) return '16:9';
  return DEFAULT_RATIOS[type] || '16:9';
}

export function missingAssetRatios(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return Object.entries(ASSET_RATIO_KEYS)
    .filter(([, key]) => !String(meta[key] || '').trim())
    .map(([assetType]) => assetType);
}

export function missingAssetTemplates(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return Object.entries(ASSET_TEMPLATE_KEYS)
    .filter(([, key]) => !String(meta[key] || '').trim())
    .map(([assetType]) => assetType);
}

export function assetTemplateTitle(item) {
  return String(
    item?.translation?.title ||
      item?.title ||
      item?.name ||
      item?.slug ||
      item?.id ||
      ''
  );
}

export async function resolveAssetTemplateId(base, token, assetType, metadata) {
  const info = await resolveAssetTemplate(base, token, assetType, metadata);
  return info.id;
}

export async function resolveAssetTemplate(base, token, assetType, metadata) {
  const type = normalizeAssetType(assetType);
  const key = templateKeyFor(type);
  const slug = String(metadata?.[key] || '').trim();
  if (!type || !slug) return { id: 0, title: '', slug: '' };
  const options = await listAssetTemplates(base, token, type);
  const hit = findAssetTemplate(options, slug);
  return {
    id: templateIdFromValue(slug, hit),
    title: hit?.title || '',
    slug,
    scopes: hit?.scopes || [],
  };
}

const GROUP_CHARACTER_PATTERN = /群体|群像|群演|众人|人群|多人|随行|随从|保镖|助理|团队|家族|组合|宾客|记者|工作人员|合影/;

export function isGroupCharacterAsset(asset) {
  const text = `${String(asset?.name || '')} ${String(asset?.description || '')} ${String(asset?.summary || '')}`;
  return GROUP_CHARACTER_PATTERN.test(text);
}

/**
 * 默认使用项目模板；仅在断言到“群体像”类角色时，自动切换到群体像模板。
 * overrideSlug 用于抽检后人工指定模板（最高优先级）。
 */
export async function resolveAssetTemplateForAsset(base, token, asset, assetType, metadata, overrideSlug = '', variant = false) {
  const type = normalizeAssetType(assetType || asset?.assetType);
  const key = templateKeyFor(type, variant);
  const mainKey = templateKeyFor(type, false);
  const slug = String(overrideSlug || metadata?.[key] || (variant ? metadata?.[mainKey] : '') || '').trim();
  const reason = overrideSlug ? 'override' : variant && metadata?.[key] ? 'variant-default' : 'default';
  if (!type) return { id: 0, title: '', slug: '', reason: 'missing-type' };
  if (!slug) return { id: 0, title: '', slug: '', reason: 'missing-template' };
  const options = await listAssetTemplates(base, token, type);
  const hit = findAssetTemplate(options, slug);
  return {
    id: templateIdFromValue(slug, hit),
    title: hit ? assetTemplateTitle(hit) : '',
    slug,
    scopes: hit?.scopes || [],
    recommendedRatio: hit?.recommendedRatio || '',
    reason,
  };
}

const TEMPLATE_RULES = {
  scene: [
    { slug: 'wiki-prompt-ms4d6jwp-hh6svs', titlePattern: '场景设定板', text: /设定板|平面图|布局图|俯视|鸟瞰|多角度|多视角|空间结构/ },
    { slug: 'wiki-page-mqqjibuq', titlePattern: '动漫场景', text: /动漫|二次元|漫画风|动画风/ },
    { slug: '3d-mqqjj2qz', titlePattern: '3D国风场景', text: /3D场景|三维场景|国风场景|古风场景/ },
    { slug: 'wiki-page-mqqjgj5e', titlePattern: '宏大场景', text: /宏大|史诗|全景|电影级|超真实|大场面/ },
  ],
  item: [
    { slug: 'wiki-page-mso1owrq', titlePattern: '多视角', text: /多视角|多角度|三视图|设定图|结构图|分解图|剖面|细节展示/ },
    { slug: 'wiki-page-mqqjkhq2', titlePattern: '古风道具', text: /古风|国风|仙侠|古代道具/ },
  ],
  creature: [
    { slug: '16-9-msidcc15', titlePattern: '多视图', text: /多视角|多角度|三视图|多视图|设定图|结构图/ },
  ],
};

export function inferTemplateRule(assetType, text) {
  const type = normalizeAssetType(assetType);
  const source = String(text || '');
  return (TEMPLATE_RULES[type] || []).find((rule) => rule.text.test(source)) || null;
}

export function layoutHintForTemplate(title) {
  const text = String(title || '');
  if (/四视图/.test(text)) {
    if (/3:4|3：4/.test(text)) {
      return '【模板布局】角色人设四视图3:4：一张图四格分栏，同一角色、同一造型、同一张脸，纯白或中性灰底，无场景、无文字、无水印。四个视图分别为：1.正面半身肖像，正对镜头；2.3/4侧头肩特写，展现侧脸与发型；3.背面全身，完整展示后背与发型后侧；4.前侧3/4全身，完整展示整体穿搭比例。四格等大、光线统一、人物身份一致。';
    }
    return '【模板布局】角色四视图设定板：同一角色的正面、侧面、背面、四分之三侧面四个全身视图并排，等大、同一造型、同一张脸，白底或中性灰底，无场景、无文字。';
  }
  if (/五视图/.test(text)) {
    return '【模板布局】角色五视图设定板：同一角色的正面、侧面、背面、两个四分之三侧面五个全身视图并排，等大、同一造型、同一张脸，白底或中性灰底，无场景、无文字。';
  }
  if (/三视图/.test(text)) {
    return '【模板布局】角色三视图设定板：同一角色的正面、侧面、背面三个全身视图并排，等大、同一造型、同一张脸，白底或中性灰底，无场景、无文字。';
  }
  if (/多视图|多角度/.test(text)) {
    return '【模板布局】角色多视图设定板：同一角色的多个全身角度并排，等大、同一造型、同一张脸，白底或中性灰底，无场景、无文字。';
  }
  if (/九宫格|九宫/.test(text)) {
    return '【模板布局】九宫格角色设定板：三行三列，同一角色的不同表情/角度，同一张脸、同一造型，格线清晰，无文字。';
  }
  return '';
}

export function isVariantReferenced(shots, variantName) {
  const name = String(variantName || '').trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`\\(@[^|)]*\\|\\s*${escaped}\\s*\\)`);
  return (shots || []).some((shot) => tag.test(String(shot?.prompt || '')));
}

export function stripLayoutHint(prompt) {
  return String(prompt || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('【模板布局】'))
    .join('\n')
    .trim();
}

export function styleWikiIdFromMetadata(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  if (meta.defaultStyleIgnored === true) return 0;
  const ids = Array.isArray(meta.defaultStyleWikiPromptIds) ? meta.defaultStyleWikiPromptIds : [];
  const first = ids.find((id) => Number(id) > 0);
  if (first) return Number(first);
  const pageId = Number(meta.defaultStyleWikiPrompt?.pageId || 0);
  return pageId > 0 ? pageId : 0;
}

export function resolveLayoutHint(title, mode, referenced) {
  const chosen = String(mode || 'none').toLowerCase();
  if (chosen === 'template') return layoutHintForTemplate(title);
  if (chosen === 'auto') return referenced ? '' : layoutHintForTemplate(title);
  return '';
}

export function assetTemplateSummary(item) {
  return String(item?.translation?.summary || item?.summary || item?.description || '');
}

export const TEMPLATE_SCOPE_LABELS = {
  public: '公共',
  team: '团队',
  mine: '我的',
};

export function templateScopeLabel(scopes) {
  const values = Array.isArray(scopes) ? scopes : [];
  return values.map((scope) => TEMPLATE_SCOPE_LABELS[scope] || scope).filter(Boolean).join('/');
}

export function findAssetTemplate(options, value) {
  const needle = String(value || '').trim();
  if (!needle || !Array.isArray(options)) return null;
  return options.find((item) => (
    (item?.id !== undefined && item?.id !== null && String(item.id) === needle)
    || String(item?.slug || '') === needle
    || (Array.isArray(item?.slugs) && item.slugs.includes(needle))
  )) || null;
}

export function mergeAssetTemplates(groups) {
  const merged = [];
  const byKey = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const item of Array.isArray(group) ? group : []) {
      if (!item) continue;
      const key = item.id > 0 ? `id:${item.id}` : `slug:${item.slug || ''}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.scopes = [...new Set([...(existing.scopes || []), ...(item.scopes || [])])];
        continue;
      }
      const copy = { ...item, scopes: [...new Set(item.scopes || [])] };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }
  return merged;
}

export function templateIdFromValue(value, hit) {
  const optionId = Number(hit?.id);
  if (Number.isFinite(optionId) && optionId > 0) return optionId;
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const numericId = Number(raw);
  return Number.isFinite(numericId) && numericId > 0 ? numericId : 0;
}

export function isAssetTemplateCandidate(item, assetType) {
  const type = normalizeAssetType(assetType);
  const meta = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  if (!type) return false;
  const stage = String(meta.storyStage || meta.story_stage || '').trim().toLowerCase();
  const taxonomy = String(meta.taxonomy_slug || meta.taxonomySlug || '').trim().toLowerCase();
  const entity = String(meta.entityType || meta.entity_type || '').trim().toLowerCase();
  // Team assets may still be stored with storyStage=canvas; taxonomy is the
  // reliable signal there. Only reject non-asset stages when no type metadata
  // exists (e.g. unclassified drafts such as a personal "12" template).
  if (stage && stage !== 'asset' && !taxonomy && !entity) return false;
  if (taxonomy && taxonomy !== TAXONOMY[type]) return false;
  if (entity && entity !== TAXONOMY[type]) return false;
  return true;
}

export function sortAssetTemplates(options) {
  return [...(Array.isArray(options) ? options : [])].sort((left, right) => {
    const a = String(left?.title || left?.slug || '');
    const b = String(right?.title || right?.slug || '');
    return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
}

const TEMPLATE_CACHE = new Map();
const TEMPLATE_CACHE_TTL_MS = 60 * 1000;

export async function listAssetTemplates(base, token, assetType, keyword) {
  const type = normalizeAssetType(assetType);
  const types = type ? [type] : Object.keys(ASSET_TEMPLATE_KEYS);
  const batches = await Promise.all(types.map(async (current) => {
    const cacheKey = `${base}|${token}|${current}|${String(keyword || '')}`;
    const cached = TEMPLATE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < TEMPLATE_CACHE_TTL_MS) {
      return cached.items;
    }
    const body = {
      taxonomySlug: TAXONOMY[current],
      taxonomyGroup: 'comic_prompt',
      storyStage: 'asset',
      entityType: TAXONOMY[current],
      mediaType: 'image',
      promptKind: 'image',
      page: 1,
      pageSize: 60,
    };
    if (keyword) body.q = String(keyword);
    const [featuredRes, teamRes, mineRes] = await Promise.all([
      httpJson(`${base}/api/v1/story-workbench/wiki-prompts/featured`, {
        method: 'POST',
        token,
        body,
      }).catch(() => null),
      httpJson(`${base}/api/v1/story-workbench/wiki-prompts/query`, {
        method: 'POST',
        token,
        body: { ...body, scope: 'team' },
      }).catch(() => null),
      httpJson(`${base}/api/v1/story-workbench/wiki-prompts/query`, {
        method: 'POST',
        token,
        body: { ...body, scope: 'mine' },
      }).catch(() => null),
    ]);
    const toOption = (res, scope) => {
      const items = res?.json?.data?.items || res?.json?.data || [];
      return (Array.isArray(items) ? items : [])
        .filter((item) => isAssetTemplateCandidate(item, current))
        .map((item) => {
        const title = assetTemplateTitle(item);
        const summary = assetTemplateSummary(item);
        return {
          assetType: current,
          assetTypeLabel: ASSET_TEMPLATE_LABELS[current],
          slug: String(item.slug || ''),
          title,
          summary,
          recommendedRatio: recommendRatio(current, title, summary),
          id: Number(item.id) || 0,
          scopes: [scope],
        };
      });
    };
    const items = sortAssetTemplates(mergeAssetTemplates([
      toOption(featuredRes, 'public'),
      toOption(teamRes, 'team'),
      toOption(mineRes, 'mine'),
    ]));
    if ([featuredRes, teamRes, mineRes].some((res) => res?.status === 200)) {
      TEMPLATE_CACHE.set(cacheKey, { items, at: Date.now() });
    }
    return items;
  }));
  return batches.flat();
}
