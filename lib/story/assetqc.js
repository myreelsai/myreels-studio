import { variantHasImage } from './image-state.js';

export function inspectVariant(asset, variant) {
  const issues = [];

  if (!variant || !variantHasImage(variant)) {
    issues.push({ code: 'no-image', level: 'error', message: '变体没有图，需要生成' });
  }
  const prompt = String(variant?.prompt || '');
  const description = String(variant?.description || '');
  const text = prompt || description;
  if (!text) {
    issues.push({ code: 'no-prompt', level: 'error', message: '变体没有 prompt/description' });
  } else if (text.length < 60) {
    issues.push({ code: 'short-prompt', level: 'warn', message: '提示词偏短，角色/道具细节可能不足' });
  }
  const names = [asset?.name, ...(variant?.aliasNames || [])].filter(Boolean);
  const isCostume = String(variant?.variantType || '') === 'costume';
  if (!isCostume && text && names.length && !names.some((name) => text.includes(name))) {
    issues.push({ code: 'name-missing', level: 'warn', message: `提示词未出现资产名/别名（${names.join(' / ')}）` });
  }
  if (variant && variant.metadata?.confirmed !== true) {
    issues.push({ code: 'unconfirmed', level: 'info', message: '尚未确认（人工或自动）' });
  }
  return issues;
}

export function hasBlockingIssues(issues) {
  return (issues || []).some((issue) => issue.level === 'error');
}
