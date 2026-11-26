import { assetNeedsSubjectImage } from './templates.js';

const normalize = (value) => String(value || '').trim();

/**
 * 生成前的资产生成包（不是“自动判定画面对错”）。
 *
 * 这里只检查平台硬约束：资产是否有描述、是否有变体、变体是否有提示词、
 * 主图/参考图是否就绪。提示词是否准确、参考素材是否足够，由 Harness
 * 读取完整提示词、剧情上下文和参考图后自行判断，并通过 confirm + reviewNotes
 * 留下审查结论。
 */
export function auditAssetPrompts({ assets = [], variantsByAsset = new Map(), shots = [] } = {}) {
  const blockers = [];
  const warnings = [];
  const items = [];
  const promptOwners = new Map();

  for (const asset of assets) {
    const id = String(asset?.id || '');
    const name = normalize(asset?.name) || id.slice(0, 8);
    const type = normalize(asset?.assetType) || 'unknown';
    const description = normalize(asset?.description);
    const variants = variantsByAsset?.get?.(id) || [];

    const placeholder = asset?.metadata?.variantBackedPlaceholder === true;
    if (!description && assetNeedsSubjectImage(type)) blockers.push(`${name}: 资产描述为空，主图缺少生成依据`);
    if (!variants.length && !placeholder) blockers.push(`${name}: 没有变体，无法生成变体图`);
    if (!variants.length && placeholder) warnings.push(`${name}: 分析器空壳占位资产，已跳过`);
    const hasReference = Boolean(normalize(asset?.referenceImageUrl)) || variants.some((v) => normalize(v?.imageUrl));
    if (assetNeedsSubjectImage(type) && !hasReference) warnings.push(`${name}: 主图/参考图尚未就绪，生成变体前会先补主图`);

    for (const variant of variants) {
      const prompt = normalize(variant?.prompt);
      const variantDescription = normalize(variant?.description);
      const variantName = normalize(variant?.name) || String(variant?.id || '').slice(0, 8);
      const shotRefs = (shots || [])
        .filter((shot) => String(shot?.prompt || '').includes(variantName))
        .map((shot) => Number(shot.shotNo))
        .filter(Number.isFinite);

      if (!prompt && !variantDescription) {
        blockers.push(`${name} / ${variantName}: 提示词和描述都为空`);
      } else {
        const promptText = prompt || variantDescription;
        const previous = promptOwners.get(promptText);
        if (previous) warnings.push(`${name} / ${variantName}: 提示词与 ${previous} 完全相同`);
        else promptOwners.set(promptText, `${name} / ${variantName}`);
      }

      items.push({
        assetId: id,
        assetName: name,
        assetType: type,
        assetDescription: description,
        variantName,
        variantType: normalize(variant?.variantType),
        prompt,
        negativePrompt: normalize(variant?.negativePrompt),
        description: variantDescription,
        hasImage: Boolean(normalize(variant?.imageUrl)),
        referenceImageUrl: normalize(asset?.referenceImageUrl || variant?.referenceImageUrl),
        imageUrl: normalize(variant?.imageUrl),
        shotRefs,
        promptLength: (prompt || variantDescription).length,
      });
    }
  }

  const refTags = (shots || [])
    .flatMap((shot) => [...String(shot?.prompt || '').matchAll(/\(@[^|)]*\|\s*([^)]+)\)/g)].map((m) => m[1].trim()))
    .filter(Boolean);
  if (refTags.length) {
    const known = new Set();
    for (const asset of assets) {
      if (asset?.name) known.add(normalize(asset.name));
      for (const variant of variantsByAsset?.get?.(asset?.id) || []) {
        if (variant?.name) known.add(normalize(variant.name));
      }
    }
    for (const name of [...new Set(refTags)].filter((name) => !known.has(name))) {
      warnings.push(`分镜引用了不存在的资产/变体：${name}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    items,
    summary: {
      assets: assets.length,
      variants: items.length,
      blockers: blockers.length,
      warnings: warnings.length,
      missingReferences: items.filter((item) => !item.referenceImageUrl && !item.imageUrl).length,
    },
  };
}
