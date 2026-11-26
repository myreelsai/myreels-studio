export class ApiError extends Error {
  constructor(status, text, json) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.text = text;
    this.json = json;
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON 请求：网络异常/429/5xx 自动重试 2 次（指数退避），最终失败返回
 * `{ status:'ERR', ok:false, error }`，调用方仍可用 status 判断，额外拿到 error 详情。
 */
export async function httpJson(url, { method = 'GET', token = '', body = null, timeout = 20000, apiKey = '' } = {}, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep null */
    }
    if (RETRYABLE.has(res.status) && attempt < 2) {
      clearTimeout(timer);
      await sleep(500 * (attempt + 1));
      return httpJson(url, { method, token, body, timeout, apiKey }, attempt + 1);
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    if (attempt < 2) {
      clearTimeout(timer);
      await sleep(500 * (attempt + 1));
      return httpJson(url, { method, token, body, timeout, apiKey }, attempt + 1);
    }
    return { ok: false, status: 'ERR', json: null, text: String(error?.message || error), error };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
