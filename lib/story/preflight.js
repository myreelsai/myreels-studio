import { resolveRefTags } from './refs.js';
import { variantHasImage } from './image-state.js';

const ERROR = 'error';
const WARN = 'warn';
const INFO = 'info';

export function shotPreflight(shot, index, videoSchema = {}) {
  const issues = [];
  const prompt = String(shot.prompt || shot.description || '');
  const resolved = resolveRefTags(prompt, index);
  const usable = resolved.filter((tag) => tag.status === 'ok');

  for (const tag of resolved) {
    if (tag.status === 'ok') continue;
    const level = tag.status === 'missing' || tag.status === 'variant-no-image' ? ERROR : WARN;
    issues.push({
      code: `ref-${tag.status}`,
      level,
      message: `(@${tag.variant} | ${tag.asset}) — ${tag.status}`,
    });
  }

  const maxImages = Number(videoSchema?.images?.maxFiles || 0);
  if (maxImages && usable.length > maxImages) {
    issues.push({ code: 'too-many-refs', level: ERROR, message: `参考图 ${usable.length} 张 > 模型上限 ${maxImages}` });
  }

  const maxLength = Number(videoSchema?.prompt?.maxLength || 0);
  if (maxLength && prompt.length > maxLength) {
    issues.push({ code: 'prompt-too-long', level: ERROR, message: `提示词 ${prompt.length} 字 > 模型上限 ${maxLength}，需精简` });
  }

  const durations = (videoSchema?.duration?.options || []).map((o) => Number(o.value)).filter((n) => n > 0);
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const target = Number(shot.durationSeconds) || 0;
  if (maxDuration && target > maxDuration) {
    issues.push({
      code: 'needs-segments',
      level: INFO,
      message: `分镜计划 ${target}s > 当前模型单段上限 ${maxDuration}s；优先换支持 ${target}s 的模型，只有明确要求时才拆段`,
    });
  }

  return {
    shotNo: Number(shot.shotNo) || 0,
    promptLength: prompt.length,
    refs: usable.length,
    issues,
  };
}

export function variantPreflight(asset, variant, imageSchema = {}) {
  const issues = [];
  const text = String(variant.prompt || variant.description || '');
  if (!text) issues.push({ code: 'no-prompt', level: ERROR, message: '缺少 prompt/description' });
  if (!variant.imageUrl) issues.push({ code: 'no-image', level: INFO, message: '还没有图，可生成' });
  const maxLength = Number(imageSchema?.prompt?.maxLength || 0);
  if (maxLength && text.length > maxLength) {
    issues.push({ code: 'prompt-too-long', level: ERROR, message: `提示词 ${text.length} 字 > 模型上限 ${maxLength}` });
  }
  const aliases = [asset?.name, ...(variant.aliasNames || [])].filter(Boolean);
  const isCostume = String(variant.variantType || '') === 'costume';
  if (!isCostume && text && aliases.length && !aliases.some((name) => text.includes(name))) {
    issues.push({ code: 'name-missing', level: WARN, message: `提示词未出现资产名（${aliases.join('/')}）` });
  }
  return { assetName: String(asset?.name || ''), variantName: String(variant.name || ''), issues };
}

export function summarizePreflight(results) {
  const all = results.flatMap((item) => item.issues || []);
  return {
    total: all.length,
    errors: all.filter((i) => i.level === ERROR).length,
    warnings: all.filter((i) => i.level === WARN).length,
    infos: all.filter((i) => i.level === INFO).length,
    ready: all.every((i) => i.level !== ERROR),
  };
}
