import { httpJson } from './http.js';

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

/**
 * 返回后端项目是否仍然可见。
 *
 * - 200 + status=deleted：已删除，隐藏
 * - 404/403：当前操作者不可见，隐藏
 * - 网络错误/5xx：保持可见，避免临时故障把本地任务全部隐藏
 */
async function backendProjectVisible(base, token, projectId) {
  const key = `${base}|${projectId}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.visible;

  const result = await httpJson(`${base}/api/v1/story-projects/${encodeURIComponent(projectId)}`, {
    token,
    timeout: 5000,
  }).catch(() => null);
  const status = Number(result?.status || 0);
  let visible = true;
  if (status === 404 || status === 403) visible = false;
  else if (status === 200) {
    const project = result?.json?.data || {};
    visible = String(project.status || '').toLowerCase() !== 'deleted' && !project.deletedAt;
  }
  cache.set(key, { visible, at: now });
  return visible;
}

export async function filterRunsByBackendProject(base, token, runs) {
  if (!base || !token || !Array.isArray(runs) || !runs.length) return runs;
  const projectIds = [...new Set(runs.map((run) => String(run.projectId || '')).filter(Boolean))];
  const visibility = new Map();
  await Promise.all(projectIds.map(async (projectId) => {
    visibility.set(projectId, await backendProjectVisible(base, token, projectId));
  }));
  return runs.filter((run) => {
    const projectId = String(run.projectId || '');
    return !projectId || visibility.get(projectId) !== false;
  });
}
