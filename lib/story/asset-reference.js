import { httpJson } from '../core/http.js';
import { resolveUserFileIdByUrl } from './client.js';

/**
 * 取资产主图的可访问 URL，用于变体生成的垫图。
 * 优先 referenceUserFileId；否则用 referenceImageUrl 反查 userFileId。
 */
export async function resolveAssetReferenceImage(base, token, asset) {
  if (!asset) return '';
  let fileId = String(asset.referenceUserFileId || '').trim();
  const rawUrl = String(asset.referenceImageUrl || '').trim();
  if (!fileId && rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    fileId = await resolveUserFileIdByUrl(base, token, rawUrl).catch(() => '');
  }
  if (fileId) {
    const dl = await httpJson(`${base}/api/v1/user-files/download/${fileId}`, { token }).catch(() => null);
    const url = typeof dl?.json?.data === 'string' ? dl.json.data : dl?.json?.data?.url;
    if (url) return String(url);
  }
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
}
