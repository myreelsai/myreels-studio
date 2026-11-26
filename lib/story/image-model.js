function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * 解析项目当前应使用的图片工具。
 *
 * WebUI 的 defaultImageModel 存工具 ID；插件旧字段 imageModelSlug 存 slug。
 * WebUI 是项目默认值的来源，因此优先使用 defaultImageModel。
 */
export function findImageTool(tools, metadata, preferredSlug = '') {
  const list = Array.isArray(tools) ? tools : [];
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const refs = [
    text(preferredSlug),
    text(meta.defaultImageModel),
    text(meta.imageModelSlug),
  ].filter(Boolean);

  for (const ref of refs) {
    const byId = list.find((tool) => text(tool?.id) === ref);
    if (byId) return byId;
    const bySlug = list.find((tool) => text(tool?.slug) === ref);
    if (bySlug) return bySlug;
    const byModelName = list.find((tool) => text(tool?.modelName) === ref);
    if (byModelName) return byModelName;
    const byLabel = list.find((tool) => text(tool?.name) === ref || text(tool?.displayName) === ref);
    if (byLabel) return byLabel;
  }
  return null;
}
