export function chooseVideoSlug({ targetSec, defaultSlug, longSlug, thresholdSec = 15 }) {
  const target = Number(targetSec) || 0;
  if (target > Number(thresholdSec) && longSlug) return String(longSlug);
  return String(defaultSlug || '');
}

export function pickDuration(target, options, override = 0) {
  const numeric = (options || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (Number(override) > 0) return Number(override);
  if (!numeric.length) return Number(target) > 0 ? Number(target) : 5;
  if (!Number(target)) return numeric[numeric.length - 1];
  const fit = numeric.filter((n) => n <= Number(target));
  return fit.length ? fit[fit.length - 1] : numeric[0];
}

export function budgetGuard({ budget, spent, nextCost }) {
  const b = Number(budget) || 0;
  const s = Number(spent) || 0;
  const n = Number(nextCost) || 0;
  if (b <= 0) return { allow: true, reason: 'no-budget' };
  if (s + n > b) return { allow: false, reason: `预算不足：已花 ${s} + 本次 ${n} > 预算 ${b}` };
  return { allow: true, reason: 'ok' };
}

export function shouldAutoConfirm(assetReview) {
  return assetReview === 'auto';
}

export function nextAction({ analysisStatus, assetsWithImage, assetsTotal, videoCount, shotsTotal }) {
  if (analysisStatus === 'queued' || analysisStatus === 'processing') return 'wait-analysis';
  if (analysisStatus === 'failed') return 'analysis-failed';
  if ((assetsWithImage || 0) < (assetsTotal || 0)) return 'generate-assets';
  if ((videoCount || 0) < (shotsTotal || 0)) return 'generate-shots';
  if ((videoCount || 0) > 0) return 'render';
  return 'done';
}

export function retryTargets(failed, maxRetries = 1) {
  const list = Array.isArray(failed) ? failed.filter((x) => x && x.status === 'failed' && (x.retries || 0) < maxRetries) : [];
  return list.map((x) => ({ ...x, retries: (x.retries || 0) + 1 }));
}

export function qcDurationOk(seconds, min = 2, max = 30.5) {
  const s = Number(seconds);
  return Number.isFinite(s) && s >= min && s <= max;
}
