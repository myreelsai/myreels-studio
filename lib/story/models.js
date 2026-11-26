const IMAGE_TAGS = ['t2i', 'i2i'];
const VIDEO_TAGS = ['t2v', 'i2v', 's2v', 'v2v'];

function isPlaceholder(model) {
  const name = String(model?.name || '');
  const modelName = String(model?.modelName || '');
  // workflow 只有在没有 slug 时才是占位工具；Nano Pro 等真实模型
  // 也使用 modelName=workflow，但必须出现在下拉列表中。
  return !modelName
    || name.includes('{{')
    || (modelName === 'workflow' && !String(model?.slug || '').trim())
    || /asr|tts/i.test(name);
}

function buildOptions(models, tools, kind) {
  const tags = kind === 'video' ? VIDEO_TAGS : IMAGE_TAGS;
  const toolByModel = new Map((tools || []).filter((tool) => tool?.modelName).map((tool) => [String(tool.modelName), tool]));
  const toolBySlug = new Map((tools || []).filter((tool) => tool?.slug).map((tool) => [String(tool.slug), tool]));
  const seen = new Set();
  const list = (models || [])
    .filter((model) => !isPlaceholder(model))
    .filter((model) => (Array.isArray(model.tags) ? model.tags : []).some((tag) => tags.includes(String(tag))))
    .filter((model) => {
      const modelName = String(model.modelName);
      const key = modelName === '{{model}}' || modelName === 'workflow'
        ? `slug:${String(model.slug || '')}`
        : modelName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((model) => {
      const modelName = String(model.modelName);
      const placeholder = modelName === '{{model}}' || modelName === 'workflow';
      const tool = placeholder ? toolBySlug.get(String(model.slug || '')) : toolByModel.get(modelName);
      const durations = (tool?.userInputSchema?.duration?.options || [])
        .map((option) => Number(option.value))
        .filter((value) => value > 0);
      return {
        modelName: String(model.modelName),
        name: String(model.name || model.modelName),
        cost: Number(model.estimatedCost) || 0,
        slug: String(tool?.slug || ''),
        inBoth: Boolean(tool),
        maxDuration: durations.length ? Math.max(...durations) : 0,
      };
    })
    .sort((a, b) => Number(b.inBoth) - Number(a.inBoth) || a.cost - b.cost);
  return list;
}

export function modelOptions(models, tools, kind) {
  const list = buildOptions(models, tools, kind);
  const catalogNames = new Set((models || []).map((model) => String(model.modelName || '')));
  const onlyTools = (tools || [])
    .map((tool) => String(tool?.modelName || ''))
    .filter((name) => name && !catalogNames.has(name))
    .slice(0, 12);
  return { list, onlyTools };
}

/** 故事台通道：模型来源就是 /tools（生成实际使用的目录）。 */
export function modelOptionsFromTools(tools, kind) {
  const catalog = (tools || []).map((tool) => ({
    modelName: tool?.modelName,
    name: tool?.name || tool?.modelName,
    estimatedCost: tool?.estimatedCost,
    tags: tool?.tags,
    isActive: tool?.isActive,
    slug: tool?.slug,
  }));
  return { list: buildOptions(catalog, tools, kind), onlyTools: [] };
}

export function matchCatalog({ models, tools, imageModel, videoModelSlug }) {
  const byName = new Map((models || []).map((model) => [String(model.modelName || ''), model]));
  const bySlug = new Map((tools || []).filter((tool) => tool?.slug).map((tool) => [String(tool.slug), tool]));
  const image = byName.get(String(imageModel || '')) || null;
  const videoTool = bySlug.get(String(videoModelSlug || '')) || null;
  const video = videoTool ? byName.get(String(videoTool.modelName || '')) || null : null;
  return {
    imageInCatalog: Boolean(image),
    imageInTools: Boolean(image && (tools || []).some((tool) => tool.modelName === image.modelName)),
    videoInCatalog: Boolean(video),
    videoInTools: Boolean(videoTool),
  };
}
