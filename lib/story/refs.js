const TAG_PATTERN = /\(@([^|)]*)\|\s*([^)]+)\)/g;

const normalize = (value) => String(value || '').replace(/\s+/g, '').replace(/[·・.。]/g, '').toLowerCase();

export function parseRefTags(prompt) {
  const tags = [];
  let match;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(String(prompt || '')))) {
    const variant = match[1].trim();
    const asset = match[2].trim();
    if (variant || asset) tags.push({ variant, asset, raw: match[0] });
  }
  return tags;
}

export function buildRefIndex(assets, variantsByAsset) {
  const byVariant = new Map();
  const byAsset = new Map();
  for (const asset of assets || []) {
    const variants = variantsByAsset?.get?.(asset.id) || [];
    byAsset.set(normalize(asset.name), {
      assetId: asset.id,
      assetName: asset.name,
      assetType: asset.assetType,
      variants,
    });
    for (const variant of variants) {
      byVariant.set(normalize(variant.name), {
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.assetType,
        variantId: variant.id,
        variantName: variant.name,
        imageUrl: variant.imageUrl || '',
        userFileId: variant.userFileId || '',
        variants,
      });
    }
  }
  return { byVariant, byAsset, assets: assets || [], variantsByAsset };
}

export function resolveRefTags(prompt, index) {
  return parseRefTags(prompt).map((tag) => {
    const variant = index.byVariant.get(normalize(tag.variant));
    if (variant && variant.imageUrl) {
      return { ...tag, status: 'ok', assetName: variant.assetName, variantName: variant.variantName, assetId: variant.assetId, variantId: variant.variantId };
    }
    if (variant) {
      return { ...tag, status: 'variant-no-image', assetName: variant.assetName, variantName: variant.variantName, assetId: variant.assetId, variantId: variant.variantId };
    }
    const asset = index.byAsset.get(normalize(tag.asset));
    if (asset) {
      const firstWithImage = (asset.variants || []).find((v) => v.imageUrl);
      return {
        ...tag,
        status: firstWithImage ? 'asset-fallback' : 'asset-no-image',
        assetName: asset.assetName,
        variantName: firstWithImage?.name || '',
        assetId: asset.assetId,
      };
    }
    return { ...tag, status: 'missing', assetName: '', variantName: '' };
  });
}

/**
 * 参考图解析：只使用标签里点名的变体图；变体没有图时宁可不带图，也不拿同资产其它变体的图顶替（T45 错误参考图）。
 */
function bigrams(value) {
  const s = normalize(value);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const A = bigrams(na);
  const B = bigrams(nb);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

export function findClosestVariant(name, index, { threshold = 0.45 } = {}) {
  let best = null;
  for (const [key, entry] of index.byVariant) {
    const score = similarity(name, entry.variantName);
    if (score >= threshold && (!best || score > best.score)) best = { ...entry, score };
  }
  if (best) return best;
  for (const [key, entry] of index.byAsset) {
    const score = similarity(name, entry.assetName);
    if (score >= threshold && (!best || score > best.score)) best = { ...entry, variantName: entry.assetName, score };
  }
  return best;
}

export function compileShotRefs(prompt, index, { allowFallback = false } = {}) {
  const source = String(prompt || '');
  const resolved = resolveRefTags(source, index);
  const usable = resolved.filter((tag) => tag.status === 'ok' || (allowFallback && tag.status === 'asset-fallback'));
  const images = [];
  const byTag = new Map();
  for (const tag of usable) {
    const key = normalize(tag.variant);
    if (byTag.has(key)) continue;
    const variant = tag.status === 'ok'
      ? index.byVariant.get(normalize(tag.variant))
      : (index.byAsset.get(normalize(tag.asset))?.variants || []).find((v) => v.imageUrl);
    if (!variant?.imageUrl) continue;
    images.push(variant.imageUrl);
    byTag.set(key, `【<<<image${images.length}>>>】`);
  }
  const compiled = source.replace(TAG_PATTERN, (raw, variantName) => {
    const key = normalize(variantName);
    if (byTag.has(key)) return byTag.get(key);
    const tag = resolved.find((t) => normalize(t.raw) === normalize(raw));
    if (tag?.status === 'variant-no-image' || tag?.status === 'asset-no-image') return tag.assetName || tag.variantName || raw;
    if (tag?.status === 'asset-fallback') return tag.assetName || raw;
    return (tag?.assetName || variantName || raw);
  });
  const issues = resolved.filter((tag) => tag.status !== 'ok');
  return { prompt: compiled, images, resolved, issues };
}
