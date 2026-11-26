import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', '..');

let runtimeWorkspaceDir = '';
let runtimeWorkspaceResolver = null;

export function setRuntimeWorkspaceDir(value) {
  runtimeWorkspaceDir = String(value || '').trim();
}

export function setRuntimeWorkspaceResolver(resolver) {
  runtimeWorkspaceResolver = typeof resolver === 'function' ? resolver : null;
}

function resolveRuntimeWorkspace() {
  if (runtimeWorkspaceResolver) {
    try {
      const value = String(runtimeWorkspaceResolver() || '').trim();
      if (value) return value;
    } catch {
      /* fall through to the static runtime value */
    }
  }
  return runtimeWorkspaceDir;
}

export function slugify(value, fallback = 'project') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const slug = text
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/**
 * 本机存储配置（工作区/产物根目录），由 myreels_storage set 写入：
 *   ~/.dsh/storages/myreels-studio/config.json
 * 优先级：参数 > 环境变量 > 本机配置 > 自动推断。
 */
export function storageConfigPath() {
  return join(homedir(), '.dsh', 'storages', 'myreels-studio', 'config.json');
}

export function readStorageConfig() {
  try {
    const parsed = JSON.parse(readFileSync(storageConfigPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function workspaceDir() {
  const envWorkspace = String(process.env.MYREELS_WORKSPACE_DIR || '').trim();
  if (envWorkspace) return envWorkspace;
  const storedWorkspace = String(readStorageConfig().workspaceDir || '').trim();
  if (storedWorkspace) return storedWorkspace;
  const dynamicWorkspace = resolveRuntimeWorkspace();
  if (dynamicWorkspace) return dynamicWorkspace;
  if (basename(PACKAGE_ROOT) === 'myreels-studio' && !PACKAGE_ROOT.split(/[\\/]/).includes('node_modules')) {
    return dirname(PACKAGE_ROOT);
  }
  const cwd = process.cwd();
  return basename(cwd) === 'myreels-studio' ? dirname(cwd) : cwd;
}

export function runsRoot(baseDir) {
  if (baseDir) return baseDir;
  const envRuns = String(process.env.MYREELS_RUNS_DIR || '').trim();
  if (envRuns) return envRuns;
  const storedRuns = String(readStorageConfig().runsRoot || '').trim();
  if (storedRuns) return storedRuns;
  return join(workspaceDir(), 'myreels-runs');
}

/**
 * 浅层目录：<root>/<项目>/<epNN>/，分镜/资产/成片/字幕/报告都在这一层。
 *   ep04/
 *     assets/      资产图
 *     shots/       每镜视频
 *     ep04.mp4     成片
 *     ep04.srt     字幕
 *     report.md    报告
 */
export function episodeLayout({ projectTitle, projectId, episodeNo, runId, baseDir } = {}) {
  const root = runsRoot(baseDir);
  const projectDir = join(root, slugify(projectTitle || projectId || 'project'));
  const epNo = Number(episodeNo) || 0;
  const epName = epNo ? `ep${String(epNo).padStart(2, '0')}` : slugify(runId || 'run', 'run').slice(0, 12);
  const episodeDir = join(projectDir, epName);
  return {
    root,
    projectDir,
    episodeDir,
    assetsDir: join(episodeDir, 'assets'),
    shotsDir: join(episodeDir, 'shots'),
    renderPath: join(episodeDir, `${epName}.mp4`),
    subtitlePath: join(episodeDir, `${epName}.srt`),
    reportPath: join(episodeDir, 'report.md'),
    epName,
  };
}

export function layoutOfState(state, baseDir) {
  if (!state) return null;
  return episodeLayout({
    projectTitle: state.projectTitle || state.title || '',
    projectId: state.projectId,
    episodeNo: state.episodeNo,
    runId: state.runId,
    baseDir,
  });
}

export function defaultRunsRootLegacy() {
  return join(homedir(), '.dsh', 'storages', 'myreels-studio');
}
