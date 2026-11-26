export function normalizeRatios(meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const pick = (key, fallback) => String(source[key] || fallback);
  return {
    character: pick('defaultCharacterRatio', '16:9'),
    scene: pick('defaultSceneRatio', '16:9'),
    image: pick('defaultImageRatio', '16:9'),
    video: pick('defaultVideoRatio', '16:9'),
    item: pick('defaultItemRatio', '1:1'),
    creature: pick('defaultCreatureRatio', '1:1'),
  };
}

const ASSET_OPTIMIZE_PROMPT_BY_TYPE = {
  character: 'story_character_image',
  item: 'story_item_image',
  scene: 'story_scene_image',
  creature: 'story_creature_image',
};

export function assetOptimizePrompt(assetType) {
  return ASSET_OPTIMIZE_PROMPT_BY_TYPE[String(assetType || '')] || '';
}

export function buildVariantGenerateBody(tool, { aspect, assetType, templateId, styleWikiId, referenceImage }) {  return {
    serviceId: tool.serviceId,
    promptResourceId: tool.id,
    generationTaskConfig: {
      serviceId: tool.serviceId,
      promptResourceId: tool.id,
      taskType: 'image',
      promptField: 'prompt',
      userInput: {
        aspect_ratio: aspect,
        size: '2K',
        n: 1,
        ...(assetOptimizePrompt(assetType) ? { optimizePrompt: assetOptimizePrompt(assetType) } : {}),
        ...(referenceImage ? { images: [String(referenceImage)] } : {}),
        // prompt1 = 项目画风，prompt2 = 资产模板
        ...(styleWikiId ? { prompt1WikiIds: [Number(styleWikiId)] } : {}),
        ...(templateId ? { prompt2WikiIds: [Number(templateId)] } : {}),
      },
      finalParameters: {
        source: 'story_workbench',
        outputType: 'image',
        assetType,
        modelId: tool.id,
        promptResourceId: tool.id,
        model: tool.modelName,
        modelName: tool.modelName,
      },
    },
  };
}

const TAG_PATTERN = /\(@[^|)]*\|\s*([^)]+)\)/g;

/**
 * 把分镜 prompt 里的 (@变体 | 角色) 标签编译成 【<<<imageN>>>】，
 * 并按出现顺序生成 images 数组（同名只取一次）。
 */
export function compileShotPrompt(shotPrompt, refMap) {
  const source = String(shotPrompt || '');
  const names = [...source.matchAll(TAG_PATTERN)].map((m) => m[1].trim());
  const images = [];
  const nameToTag = new Map();
  for (const name of names) {
    if (!refMap.has(name) || nameToTag.has(name)) continue;
    images.push(refMap.get(name));
    nameToTag.set(name, `【<<<image${images.length}>>>】`);
  }
  const prompt = source.replace(TAG_PATTERN, (m, name) => nameToTag.get(name.trim()) || name.trim());
  return { prompt, images };
}
