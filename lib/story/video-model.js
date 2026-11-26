function text(value) {
  return String(value == null ? '' : value).trim();
}

function routeOf(tool) {
  return text(tool?.userInputSchema?.model?.default
    || (tool?.modelName && tool.modelName !== '{{model}}' ? tool.modelName : ''));
}

/**
 * 解析项目当前应使用的视频工具。
 *
 * 优先级：
 * 1. 显式传入的 videoModelSlug
 * 2. WebUI 的 defaultMultiVideoModel
 * 3. WebUI 的 defaultVideoModel
 * 4. 插件旧的 videoModelSlug
 *
 * WebUI 的 default 字段可能存 slug、modelName 或模型路由，
 * 三种形式都要能匹配。
 */
export function findVideoTool(tools, metadata, preferredSlug = '') {
  const list = Array.isArray(tools) ? tools : [];
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const refs = [
    text(preferredSlug),
    text(meta.defaultMultiVideoModel),
    text(meta.defaultVideoModel),
    text(meta.videoModelSlug),
  ].filter(Boolean);

  for (const ref of refs) {
    const bySlug = list.find((tool) => text(tool?.slug) === ref);
    if (bySlug) return bySlug;
    const byModelName = list.find((tool) => text(tool?.modelName) === ref);
    if (byModelName) return byModelName;
    const byRoute = list.find((tool) => routeOf(tool) === ref);
    if (byRoute) return byRoute;
    const byLabel = list.find((tool) => text(tool?.name) === ref || text(tool?.displayName) === ref);
    if (byLabel) return byLabel;
  }
  return null;
}

/** WebUI 下拉选项使用的值：modelName 优先，占位符回退 slug。 */
export function videoToolOptionValue(tool) {
  if (!tool) return '';
  const modelName = text(tool.modelName);
  return modelName && modelName !== '{{model}}' ? modelName : text(tool.slug);
}
