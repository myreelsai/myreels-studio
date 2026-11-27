import { AsyncLocalStorage } from 'node:async_hooks';
import { PLUGIN_ID, DEFAULT_API, configOf } from './config.js';
import { readdirSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, extname } from 'node:path';
import { stateDir, readRunState, writeRunState } from './core/state.js';
import { layoutOfState, runsRoot, setRuntimeWorkspaceDir, setRuntimeWorkspaceResolver } from './storage/layout.js';
import { credentialsOf, loginToken, authStatus, logoutAuthSession, resumeAuthSession, beginOAuthLogin, consumeOAuthState, saveOAuthSession } from './core/auth.js';
import { localRunVisible } from './core/owner.js';
import { filterRunsByBackendProject } from './core/project-visibility.js';
import { autonomyStatus, setAutonomy } from './core/autonomy.js';
import { lookupRunStatus, fetchStyleCandidates, fetchAnalyzerTool } from './story/client.js';
import { httpJson } from './core/http.js';
import { listAssetTemplates } from './story/templates.js';
import { putProjectMetadata } from './story/client.js';
import { modelOptionsFromTools } from './story/models.js';
import { findVideoTool, videoToolOptionValue } from './story/video-model.js';
import { findImageTool } from './story/image-model.js';
import envCheck from './tools/env-check.js';
import plan from './tools/plan.js';
import settings from './tools/settings.js';
import templates from './tools/templates.js';
import runStart from './tools/run-start.js';
import runStatus from './tools/run-status.js';
import runConfirm from './tools/run-confirm.js';
import runAdvance from './tools/run-advance.js';
import render from './tools/render.js';
import report from './tools/report.js';
import subtitle from './tools/subtitle.js';
import refcheck from './tools/refcheck.js';
import assetcheck from './tools/assetcheck.js';
import assetAudit from './tools/asset-audit.js';
import reviewMode from './tools/review-mode.js';
import assetfix from './tools/assetfix.js';
import shotfix from './tools/shotfix.js';
import auto from './tools/auto.js';
import snapshot from './tools/snapshot.js';
import runs from './tools/runs.js';
import preflight from './tools/preflight.js';
import segments from './tools/segments.js';
import rules from './tools/rules.js';
import episodeAdd from './tools/episode-add.js';
import episodeBatch from './tools/episode-batch.js';
import wait from './tools/wait.js';
import scriptSplit from './tools/script-split.js';
import scriptCheck from './tools/script-check.js';
import shotAudit from './tools/shot-audit.js';
import shotSplit from './tools/shot-split.js';
import assetAdd from './tools/asset-add.js';
import assetMain from './tools/asset-main.js';
import coverage from './tools/coverage.js';
import scriptFidelity from './tools/script-fidelity.js';
import analysisRetry from './tools/analysis-retry.js';
import analysisConfirm from './tools/analysis-confirm.js';
import runsClaim from './tools/runs-claim.js';
import preview, { buildPreview } from './tools/preview.js';
import reviewItems from './tools/review-items.js';
import logout from './tools/logout.js';
import autonomy from './tools/autonomy.js';
import storage from './tools/storage.js';
import projectOpen from './tools/project-open.js';

export const name = 'myreels-studio';
export const inject = ['tools', 'systemPrompt'];

const PREVIEW_BUILD_JOBS = new Map();
const toolExecutionStorage = new AsyncLocalStorage();

const TOOL_FACTORIES = [envCheck, plan, settings, templates, runStart, runStatus, runConfirm, runAdvance, auto, render, report, subtitle, refcheck, assetcheck, assetAudit, reviewMode, assetfix, shotfix, snapshot, runs, preflight, segments, rules, episodeAdd, episodeBatch, wait, scriptSplit, scriptCheck, scriptFidelity, shotAudit, shotSplit, assetAdd, assetMain, coverage, analysisRetry, preview, reviewItems, logout, autonomy, storage, projectOpen, analysisConfirm, runsClaim];

function activeRunsText() {
  try {
    const files = readdirSync(stateDir()).filter((n) => n.endsWith('.json') && !n.includes('.tmp-'));
    const runs = [];
    for (const file of files) {
      try {
        const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
        if (!state?.runId) continue;
        runs.push({
          runId: String(state.runId),
          title: String(state.projectTitle || state.projectId || ''),
          ep: Number(state.episodeNo) || 0,
          stage: String(state.stage || ''),
          updatedAt: String(state.lastAdvanceAt || state.createdAt || ''),
          spent: Number(state.spentPoints || 0),
          budget: Number(state.settings?.budgetPoints || 0),
        });
      } catch {
        /* skip */
      }
    }
    runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!runs.length) return '';
    const lines = ['[MyReels Studio] 最近 run（只读；决策前用 myreels_snapshot 取详情）'];
    for (const run of runs.slice(0, 5)) {
      lines.push(`- ${run.runId.slice(0, 8)} | ${run.title || '?'} | EP${run.ep || '?'} | ${run.stage || '?'} | ${run.spent}/${run.budget} 点 | ${run.updatedAt}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function listRuns() {
  let names = [];
  try {
    names = readdirSync(stateDir()).filter((n) => n.endsWith('.json') && !n.includes('.tmp-'));
  } catch {
    return [];
  }
  const runs = [];
  for (const file of names) {
    try {
      const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
      if (!state || !state.runId) continue;
      runs.push({
        runId: String(state.runId),
        projectId: String(state.projectId || ''),
        title: String(state.projectTitle || state.projectTitle || state.projectId || ''),
        episodeNo: Number(state.episodeNo) || 0,
        stage: String(state.stage || ''),
        createdAt: String(state.createdAt || ''),
        updatedAt: String(state.lastAdvanceAt || state.createdAt || ''),
        ownerUserId: String(state.ownerUserId || ''),
        ownerUsername: String(state.ownerUsername || ''),
        ownerKey: String(state.ownerKey || ''),
        ownerType: String(state.ownerType || ''),
        ownerSubaccountId: state.ownerSubaccountId ?? null,
        ownerLabel: String(state.ownerLabel || ''),
      });
    } catch {
      /* skip unreadable state file */
    }
  }
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return runs.slice(0, 500);
}

async function canViewRun(base, token, viewer, runId) {
  const state = readRunState(runId);
  if (!state) return { ok: false, status: 404 };
  const session = authStatus();
  const uid = String(viewer?.userId || session.userId || '');
  if (!uid) return { ok: false, status: 403 };
  if (state.ownerKey || session.isSubaccount) {
    return localRunVisible(state, session) ? { ok: true, state } : { ok: false, status: 404 };
  }
  if (state.ownerUserId) {
    return String(state.ownerUserId) === uid ? { ok: true, state } : { ok: false, status: 404 };
  }
  if (!state.projectId) return { ok: false, status: 404 };
  const project = await httpJson(`${base}/api/v1/story-projects/${encodeURIComponent(state.projectId)}`, { token }).catch(() => null);
  if (!project || project.status !== 200) return { ok: false, status: 404 };
  writeRunState(runId, { ...state, ownerUserId: uid, ownerUsername: String(viewer.username || '') });
  return { ok: true, state };
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function deleteLocalRun(runId) {
  const id = String(runId || '').trim();
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return { ok: false, error: 'bad runId' };
  const state = readRunState(id);
  const removed = [];
  const remove = (target) => {
    if (!target || !existsSync(target)) return;
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  };
  const storage = runsRoot();
  remove(join(stateDir(), `${id}.json`));
  remove(join(stateDir(), `${id}.lock`));
  remove(join(storage, '.previews', id));
  remove(join(storage, '.reports', `${id}.md`));
  remove(join(storage, '.renders', `${id}.mp4`));
  remove(join(storage, '.subtitles', `${id}.srt`));
  if (state) {
    const layout = layoutOfState(state);
    remove(layout?.episodeDir);
  }
  return { ok: true, runId: id, removed };
}

function reportPathOf(runId) {
  const legacy = join(runsRoot(), '.reports', `${runId}.md`);
  const layout = layoutOfState(readRunState(runId));
  const candidates = [layout?.reportPath, legacy].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || legacy;
}

const STORY_TOOLS_CACHE = new Map();
const STORY_TOOLS_CACHE_TTL_MS = 60 * 1000;

async function loadStoryTools(base, token) {
  const key = `${base}|${token}`;
  const cached = STORY_TOOLS_CACHE.get(key);
  if (cached && Date.now() - cached.at < STORY_TOOLS_CACHE_TTL_MS) {
    return cached.tools;
  }
  try {
    const res = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
    const tools = Array.isArray(res.json?.data?.items) ? res.json.data.items : [];
    if (tools.length) STORY_TOOLS_CACHE.set(key, { tools, at: Date.now() });
    return tools;
  } catch {
    return [];
  }
}

function readJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : null;
  } catch {
    return null;
  }
}

async function listRemoteProjects(base, token) {
  try {
    const groupsRes = await httpJson(
      `${base}/api/v1/canvas/project-groups?page=1&pageSize=100&limit=100&scope=all`,
      { token },
    ).catch(() => null);
    const byProjectId = new Map();
    const add = (projectId, title, groupId, ownerKey = '') => {
      const id = String(projectId || '');
      if (!id || byProjectId.has(id)) return;
      byProjectId.set(id, { projectId: id, title: String(title || id), groupId: Number(groupId) || 0, ownerKey: String(ownerKey || '') });
    };
    const groups = Array.isArray(groupsRes?.json?.data?.items) ? groupsRes.json.data.items : [];
    for (const item of groups) {
      if (!item || String(item.status || '') === 'deleted' || item.deletedAt) continue;
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
      if (String(metadata.source || '') !== 'dsh-agent' && metadata.harnessManaged !== true) continue;
      add(item.storyProjectId || item.story_project_id, item.name || item.storyProjectId || item.id, item.id, metadata.harnessOwnerKey);
    }
    const result = [...byProjectId.values()];
    await Promise.all(result.map(async (project) => {
      try {
        const r = await httpJson(`${base}/api/v1/story-projects/${encodeURIComponent(project.projectId)}/episodes?page=1&limit=1`, { token });
        const total = Number(r.json?.data?.pagination?.total);
        if (Number.isFinite(total) && total > 0) project.episodeCount = total;
      } catch {
        /* count is optional */
      }
    }));
    return result;
  } catch {
    return [];
  }
}


async function checkRunAccess(config, runId) {
  const state = readRunState(runId);
  if (!state) return { ok: false, status: 404 };
  const session = authStatus();
  if (session.userId && (state.ownerKey || session.isSubaccount)) {
    return localRunVisible(state, session) ? { ok: true, state } : { ok: false, status: 404 };
  }
  if (session.userId && state.ownerUserId) {
    return String(state.ownerUserId) === String(session.userId) ? { ok: true, state } : { ok: false, status: 404 };
  }
  return canAccessRunWithConfig(config, runId);
}

async function canAccessRunWithConfig(config, runId) {
  const base = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
  const token = await loginToken(base, credentialsOf(config));
  let viewer = { userId: String(authStatus().userId || ''), username: String(authStatus().username || '') };
  if (token) {
    const meRes = await httpJson(`${base}/api/v1/users/me`, { token, apiKey: configOf(config).publicApiKey || '' }).catch(() => null);
    const me = meRes?.json?.data || meRes?.json || {};
    viewer = { userId: String(me.id ?? viewer.userId ?? ''), username: String(me.username || viewer.username || '') };
  }
  return canViewRun(base, token, viewer, runId);
}

async function runDetail(config, runId) {
  const state = readRunState(runId);
  if (!state) return null;
  const base = (configOf(config).apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
  const currentLayout = layoutOfState(state);
  const currentRenderPath = currentLayout?.renderPath || '';
  const currentSubtitlePath = currentLayout?.subtitlePath || '';
  const detail = {
    runId,
    projectId: String(state.projectId || ''),
    episodeNo: Number(state.episodeNo) || 0,
    stage: String(state.stage || ''),
    createdAt: String(state.createdAt || ''),
    updatedAt: String(state.lastAdvanceAt || state.createdAt || ''),
    assetsCount: null,
    assetsWithImage: null,
    shotsCount: null,
    videoCount: null,
    nextAction: '',
    liveError: '',
    reportExists: existsSync(reportPathOf(runId)),
    renderPath: currentRenderPath && existsSync(currentRenderPath) ? currentRenderPath : String(state.renderPath || ''),
    subtitlePath: currentSubtitlePath && existsSync(currentSubtitlePath) ? currentSubtitlePath : String(state.subtitlePath || ''),
  };
  try {
    const token = await loginToken(base, credentialsOf(configOf(config)));
      if (!token) throw new Error('未登录，请先完成 MyReels SSO 登录');
    const status = await lookupRunStatus(base, token, state, { skipVariantScan: true });
    detail.stage = status.stage || detail.stage;
    detail.assetsCount = status.assetsCount;
    detail.assetsWithImage = status.assetsWithImage;
    detail.shotsCount = status.shotsCount;
    detail.videoCount = status.videoCount;
    detail.nextAction = state.needHuman
      ? 'confirm-assets'
      : state.renderPath
        ? (state.renderPartial ? 'render' : 'done')
        : state.shotsDone
          ? 'render'
          : state.assetsConfirmed
            ? 'generate-shots'
            : 'generate-assets';
  } catch (error) {
    detail.liveError = String(error?.message || error);
  }
  return detail;
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readFormBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function registerPanelRoutes(ctx, config) {
  ctx.inject(['webServer'], (sctx) => {
    const dispose = sctx.webServer.register({
      kind: 'prefix',
      path: '/plugins/myreels-studio',
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/plugins/myreels-studio/logout' && req.method === 'POST') {
          logoutAuthSession();
          res.writeHead(302, { Location: '/plugins/myreels-studio/tasks?loggedOut=1' });
          res.end();
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/login' && req.method === 'POST') {
          resumeAuthSession();
          res.writeHead(302, { Location: '/plugins/myreels-studio/tasks?loggedIn=1' });
          res.end();
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/auth/open' && req.method === 'POST') {
          try {
            const host = String(req.headers.host || '127.0.0.1');
            const startUrl = `http://${host}/plugins/myreels-studio/auth/start?external=1&_t=${Date.now()}`;
            const child = process.platform === 'win32'
              ? spawn('cmd.exe', ['/c', 'start', '', startUrl], { detached: true, stdio: 'ignore', windowsHide: true })
              : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [startUrl], { detached: true, stdio: 'ignore' });
            child.unref();
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) });
          }
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/auth/start' && req.method === 'GET') {
          const state = beginOAuthLogin();
          const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
          const host = String(req.headers.host || '127.0.0.1');
          const redirectUri = `${proto}://${host}/plugins/myreels-studio/auth/callback`;
          const webBase = String(configOf(config).webBaseUrl || 'https://myreels.tv').replace(/\/+$/, '');
          const loginUrl = `${webBase}/login?client=myreels-studio&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&_t=${Date.now()}`;
          res.writeHead(302, { Location: loginUrl, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/auth/callback' && req.method === 'GET') {
          const code = String(url.searchParams.get('code') || '');
          const state = String(url.searchParams.get('state') || '');
          const errorText = String(url.searchParams.get('error') || '');
          const base = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const authBase = (configOf(config).authBaseUrl || base).replace(/\/+$/, '');
          const fail = (message) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(`<!doctype html><meta charset="utf-8"><title>MyReels Studio 登录失败</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;padding:80px 24px;max-width:720px}h1{font-size:22px}p{color:#6b7280;line-height:1.8}a{color:#2563eb}</style><h1>MyReels Studio 登录失败</h1><p>${message}</p><p><a href="/plugins/myreels-studio/auth/start">重新打开 myreels.tv 登录</a></p><script>try{if(window.opener){setTimeout(function(){window.close();},1200);}}catch(e){}</script>`);
          };
          if (errorText) { fail(`授权被取消：${errorText}`); return; }
          if (!code) { fail('缺少授权码'); return; }
          if (!consumeOAuthState(state)) { fail('登录状态已失效，请重新发起登录'); return; }
          try {
            const exchangeBases = [...new Set([
              authBase,
              base,
              'https://api.myreels.ai',
              'https://api.myreels.tv',
            ].filter(Boolean).map((value) => String(value).replace(/\/+$/, '')))];
            let exchangeBase = '';
            let data = {};
            let lastExchangeMessage = 'ticket exchange failed';
            for (const candidateBase of exchangeBases) {
              const r = await httpJson(`${candidateBase}/api/v1/auth/sso/exchange`, {
                method: 'POST',
                body: { client: 'myreels-studio', code },
                apiKey: configOf(config).publicApiKey || '',
              });
              const candidateData = r.json?.data?.data || r.json?.data || {};
              if (candidateData.accessToken) {
                data = candidateData;
                exchangeBase = candidateBase;
                break;
              }
              lastExchangeMessage = r.json?.message || lastExchangeMessage;
            }
            if (!data.accessToken) throw new Error(lastExchangeMessage);
            let username = String(data.username || '');
            if (!username) {
              const me = await withTimeout(httpJson(`${exchangeBase}/api/v1/users/me`, { token: data.accessToken, apiKey: configOf(config).publicApiKey || '' }).catch(() => null), 3000, null);
              const u = me?.json?.data || me?.json || {};
              username = String(u.username || u.display_name || u.email || '');
            }
            saveOAuthSession({
              accessToken: data.accessToken,
              refreshToken: data.refreshToken || '',
              userId: data.userId,
              username,
              provider: 'myreels',
              apiBaseUrl: exchangeBase,
              operatorType: data.operatorType || 'user',
              operatorSubaccountId: data.operatorSubaccountId ?? null,
              operatorLabel: data.operatorLabel || '',
              authenticatedUserId: data.authenticatedUserId ?? null,
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            const requestedLang = String(url.searchParams.get('lang') || req.headers['accept-language'] || '').toLowerCase();
            const callbackLang = requestedLang.startsWith('zh') ? 'zh' : requestedLang.startsWith('ja') ? 'ja' : requestedLang.startsWith('ko') ? 'ko' : 'en';
            const callbackCopy = {
              zh: { title: 'MyReels Studio 登录成功', heading: '登录成功', message: '插件已获取 MyReels 登录态，可以关闭此窗口。', connected: '插件已获取 MyReels 登录态。', close: '关闭窗口', manualClose: '浏览器不允许自动关闭此窗口，请手动关闭标签页。' },
              ja: { title: 'MyReels Studio ログイン成功', heading: 'ログイン成功', message: 'MyReels Studio との連携が完了しました。このウィンドウを閉じられます。', connected: 'MyReels Studio との連携が完了しました。', close: 'ウィンドウを閉じる', manualClose: 'ブラウザが自動で閉じることを許可していません。タブを手動で閉じてください。' },
              ko: { title: 'MyReels Studio 로그인 성공', heading: '로그인 성공', message: 'MyReels Studio 연결이 완료되었습니다. 이 창을 닫아도 됩니다.', connected: 'MyReels Studio 연결이 완료되었습니다.', close: '창 닫기', manualClose: '브라우저가 자동 닫기를 허용하지 않습니다. 탭을 직접 닫아 주세요.' },
              en: { title: 'MyReels Studio sign-in successful', heading: 'Signed in', message: 'MyReels Studio is now connected. You can close this window.', connected: 'MyReels Studio is now connected.', close: 'Close window', manualClose: 'The browser did not allow this window to close automatically. Please close the tab manually.' },
            };
            const callbackText = callbackCopy[callbackLang] || callbackCopy.en;
            const loginProvider = String(url.searchParams.get('loginProvider') || '').toLowerCase();
            const hideCloseControls = loginProvider === 'wechat';
            const successMessage = hideCloseControls ? callbackText.connected : callbackText.message;
            const closeControls = hideCloseControls
              ? ''
              : `<button id="closeButton" onclick="closeStudioWindow()">${callbackText.close}</button><p id="closeHint" style="display:none;color:#b45309;line-height:1.7">${callbackText.manualClose}</p>`;
            res.end(`<!doctype html><meta charset="utf-8"><title>${callbackText.title}</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#1f2937;font-family:system-ui,"Microsoft YaHei",sans-serif}.card{text-align:center;padding:32px 40px;border:1px solid #e5e7eb;border-radius:16px;background:#fff;box-shadow:0 12px 36px rgba(15,23,42,.08);min-width:320px}h1{font-size:22px;margin:0 0 12px}p{color:#6b7280;line-height:1.8;margin:0 0 20px}button{border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;padding:8px 18px;font-size:14px;cursor:pointer}button:hover{background:#f9fafb}</style><div class="card"><h1>${callbackText.heading}</h1><p>${successMessage}</p>${closeControls}</div><script>function closeStudioWindow(){try{window.close();}catch(e){}setTimeout(function(){var hint=document.getElementById('closeHint');var button=document.getElementById('closeButton');if(hint){hint.style.display='block';}if(button){button.style.display='none';}},350);}try{window.parent.postMessage({type:'myreels-auth-ok'},'*');if(window.opener){setTimeout(function(){window.close();},1000);}}catch(e){}</script>`);
          } catch (error) {
            fail(String(error?.message || error));
          }
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/project-preview') {
          if (authStatus().loggedOut) {
            res.writeHead(302, { Location: '/plugins/myreels-studio/tasks?loggedOut=1' });
            res.end();
            return;
          }
          const projectId = String(url.searchParams.get('projectId') || '').trim();
          const embed = url.searchParams.get('embed') === '1';
          // 预览是单页双 tab：刷新时只重建当前 tab，并保持 tab 选中。
          const previewTab = url.searchParams.get('tab') === 'shots' ? 'shots' : 'assets';
          const tabHash = previewTab === 'shots' ? '#shots' : '';
          const previewRoot = join(runsRoot(), '.previews');
          if (!projectId) {
            sendJson(res, 400, { error: 'projectId required' });
            return;
          }
          const projectRuns = () => listRuns().filter((run) => run.projectId === projectId && localRunVisible(run, authStatus()));
          const previewHasFigures = (file) => {
            try {
              const html = readFileSync(file, 'utf8');
              return /<figure\b/.test(html) && html.includes('myreels-preview-version');
            } catch {
              return false;
            }
          };
          const findPreview = (runs) => runs.find((run) => (
            ['assets.html', 'index.html'].some((name) => {
              const file = join(previewRoot, run.runId, name);
              return existsSync(file) && previewHasFigures(file);
            })
          ));
          const runs = projectRuns();
          const latest = findPreview(runs);
          const regenerate = url.searchParams.get('generate') === '1';
          if (latest && !regenerate) {
            const page = existsSync(join(previewRoot, latest.runId, 'assets.html')) ? 'assets.html' : 'index.html';
            res.writeHead(302, { Location: `/plugins/myreels-studio/preview/${encodeURIComponent(latest.runId)}/${page}${embed ? '?embed=1' : ''}${tabHash}` });
            res.end();
            return;
          }
          const emptyPage = (text) => `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 资产预览</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;padding:70px 24px;max-width:760px;margin:0 auto}.backbtn{display:inline-block;margin-bottom:18px;color:#2563eb;text-decoration:none;font-size:13px}h1{font-size:22px}p{color:#6b7280;font-size:14px;line-height:1.7}button{padding:8px 16px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}</style><a class="backbtn" href="/plugins/myreels-studio/tasks">← 返回任务列表</a><h1>资产预览</h1><p>${text}</p><button onclick="location.reload()">重试</button>`;
          if (!runs.length) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(emptyPage('这个项目还没有 run，先生成资产后再预览。'));
            return;
          }
          const runId = String((latest || runs[0]).runId || '');
          if (url.searchParams.get('generate') !== '1') {
            const loading = `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 资产预览</title><style>html,body{margin:0;height:100%;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937}.loading-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(247,248,250,.96);z-index:9999;font-size:13px;color:#374151}.spinner{width:28px;height:28px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="loading-overlay"><div class="spinner"></div><div id="preview-label">正在生成资产预览，请稍候…</div></div><script>(async()=>{const label=document.getElementById('preview-label');try{const u=new URL(location.href);u.searchParams.set('generate','1');const r=await fetch(u,{cache:'no-store',credentials:'same-origin'});if(!r.redirected)throw new Error('预览尚未生成');location.reload()}catch(e){if(label){label.textContent='生成失败：'+(e.message||e);label.insertAdjacentHTML('afterend','<p style="margin-top:10px"><a href="#" onclick="location.reload()">重试</a></p>')}}})();</script>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(loading);
            return;
          }
          try {
            let job = PREVIEW_BUILD_JOBS.get(projectId);
            if (!job) {
              job = buildPreview(config, { runId, scope: previewTab }).finally(() => PREVIEW_BUILD_JOBS.delete(projectId));
              PREVIEW_BUILD_JOBS.set(projectId, job);
            }
            await job;
          } catch (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(emptyPage(`生成失败：${String(error?.message || error)}`));
            return;
          }
          const after = findPreview(projectRuns());
          if (!after) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(emptyPage('项目里还没有可预览的资产图；生成资产后会自动刷新。'));
            return;
          }
          const page = existsSync(join(previewRoot, after.runId, 'assets.html')) ? 'assets.html' : 'index.html';
          const query = new URLSearchParams();
          if (embed) query.set('embed', '1');
          if (regenerate) query.set('v', String(Date.now()));
          const suffix = query.toString() ? `?${query.toString()}` : '';
          res.writeHead(302, { Location: `/plugins/myreels-studio/preview/${encodeURIComponent(after.runId)}/${page}${suffix}${tabHash}` });
          res.end();
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/previews' || url.pathname === '/plugins/myreels-studio/previews/') {
          // 预览索引页已废弃；保留旧链接跳转到任务列表。
          res.writeHead(302, { Location: '/plugins/myreels-studio/tasks' });
          res.end();
          return;
        }
        if (url.pathname.startsWith('/plugins/myreels-studio/preview/')) {
          if (authStatus().loggedOut) { sendJson(res, 401, { error: 'logged out' }); return; }
          const rel = decodeURIComponent(url.pathname.slice('/plugins/myreels-studio/preview/'.length)).replace(/\\/g, '/');
          if (!rel || rel.includes('..')) {
            sendJson(res, 400, { error: 'bad preview path' });
            return;
          }
          const file = join(runsRoot(), '.previews', rel);
          if (!existsSync(file) || !statSync(file).isFile()) {
            sendJson(res, 404, { error: 'preview not found', path: rel });
            return;
          }
          const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.css': 'text/css', '.js': 'text/javascript' }[extname(file).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
          res.end(readFileSync(file));
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/tasks') {
          if (authStatus().loggedOut) {
            const page = `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 已退出登录</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;margin:0;padding:90px 24px;max-width:720px} .backbtn{position:fixed;top:14px;left:14px;z-index:100;padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#2563eb;text-decoration:none;font-size:13px}h1{font-size:22px;margin:0 0 10px}p{color:#6b7280;font-size:14px;line-height:1.8}button{padding:9px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}</style><a class="backbtn" href="/">← 返回 Harness</a><h1>已退出 MyReels Studio 登录</h1><p>插件已清除本地登录态，项目文件未删除。请通过 myreels.tv 重新授权。</p><form method="get" action="/plugins/myreels-studio/auth/start"><button type="submit">使用 myreels.tv 登录</button></form>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(page);
            return;
          }
          const taskBase = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const projectsToken = await withTimeout(loginToken(taskBase, credentialsOf(config)), 3000, '');
          let taskViewer = { userId: String(authStatus().userId || ''), username: String(authStatus().username || '') };
          if (projectsToken) {
            const meRes = await withTimeout(httpJson(`${taskBase}/api/v1/users/me`, { token: projectsToken, apiKey: configOf(config).publicApiKey || '' }).catch(() => null), 3000, null);
            const me = meRes?.json?.data || meRes?.json || {};
            taskViewer = { userId: String(me.id ?? taskViewer.userId ?? ''), username: String(me.username || taskViewer.username || '') };
          }
          const taskSession = authStatus();
          const runs = taskViewer.userId
            ? listRuns().filter((run) => localRunVisible(run, taskSession))
            : [];
          const stageLabels = { CREATED: '已创建', ANALYZING: '分析中', ANALYSIS_DONE: '分析完成', ASSETS_DONE: '资产完成', SHOTS_DONE: '分镜完成', RENDERED: '已出片', FAILED: '失败' };
          const groups = [];
          const byProject = new Map();
          for (const run of runs) {
            const key = run.projectId || `run:${run.runId}`;
            if (!byProject.has(key)) {
              const group = { projectId: run.projectId || '', title: run.title || run.projectId || run.runId, runs: [] };
              byProject.set(key, group);
              groups.push(group);
            }
            byProject.get(key).runs.push(run);
          }
          const remoteProjects = projectsToken ? await withTimeout(listRemoteProjects(taskBase, projectsToken), 3000, []) : [];
          for (const project of remoteProjects) {
            if (!project.projectId || byProject.has(project.projectId)) continue;
            const group = { projectId: project.projectId, title: project.title || project.projectId, runs: [] };
            byProject.set(project.projectId, group);
            groups.push(group);
          }
          const currentProjectId = groups[0]?.projectId || '';
          const rows = groups.map((group, index) => {
            const current = Boolean(group.projectId) && group.projectId === currentProjectId;
            const groupKey = `g${index}`;
            const epRows = [...group.runs].sort((a, b) => (Number(a.episodeNo) || 0) - (Number(b.episodeNo) || 0)).map((run) => {
              return `<tr class="eprow" data-project="${groupKey}" style="${current ? '' : 'display:none'}"><td><div class="ep">${run.episodeNo ? `EP ${run.episodeNo}` : '--'}</div><div class="rid">${htmlEscape(run.runId)}</div></td><td><span class="badge">${htmlEscape(stageLabels[run.stage] || run.stage || '--')}</span></td><td class="time">${htmlEscape(run.updatedAt)}</td><td class="actions"><form method="post" action="/plugins/myreels-studio/runs/${encodeURIComponent(run.runId)}/delete" onsubmit="return confirm('删除这一集任务的全部本地内容？\\n不会删除 WebUI 故事台数据。');"><button class="danger" type="submit">删除本地</button></form></td></tr>`;
            }).join('');
            const head = `<tr class="grouphead ${current ? 'current open' : ''}" data-project="${groupKey}" onclick="if(event.target.closest('a'))return;toggleProject('${groupKey}')"><td colspan="4"><span class="arrow">${current ? '▾' : '▸'}</span><a class="title" href="/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(group.projectId)}">${htmlEscape(group.title)}</a><span class="curr" style="${current ? '' : 'display:none'}">当前项目</span><span class="meta">${group.runs.length} 集</span><a class="act setting" style="margin-right:10px" href="/plugins/myreels-studio/project-preview?projectId=${encodeURIComponent(group.projectId)}">资产预览</a><a class="act setting" href="/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(group.projectId)}">项目设置</a></td></tr>`;
            return head + epRows;
          }).join('');
          const page = `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 任务列表</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;margin:0;padding:70px 24px 24px}header{max-width:1100px;margin:0 auto 18px}h1{margin:0 0 6px;font-size:22px}.sub{color:#6b7280;font-size:13px}.backbtn{position:fixed;top:14px;left:14px;z-index:100;padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#2563eb;text-decoration:none;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.08)}table{width:100%;max-width:1100px;margin:0 auto;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}th,td{padding:11px 14px;border-bottom:1px solid #eef0f3;text-align:left;font-size:13px;vertical-align:middle}th{background:#f9fafb;color:#6b7280;font-weight:500}.grouphead td{background:#f8fafc;padding:10px 14px;cursor:pointer}.grouphead.current td{background:#eff6ff;box-shadow:inset 3px 0 0 #2563eb}.arrow{display:inline-block;width:14px;color:#6b7280;font-size:11px}.grouphead .title{font-size:14px}.meta{margin-left:8px;font-size:11px;color:#6b7280}.setting{margin-left:auto;float:right}.ep{font-weight:600;color:#111827}.rid{color:#9ca3af;font-family:monospace;font-size:11px;margin-top:3px}.curr{display:inline-block;margin-left:8px;font-size:10px;color:#1d4ed8;background:#dbeafe;border:1px solid #bfdbfe;border-radius:999px;padding:1px 7px;vertical-align:middle}.title{color:#111827;text-decoration:none;font-weight:600}.title:hover{color:#2563eb}.rid{color:#9ca3af;font-family:monospace;font-size:11px;margin-top:3px}.badge{display:inline-block;padding:2px 9px;border-radius:999px;border:1px solid #a7f3d0;background:#ecfdf5;color:#047857;font-size:12px}.time{color:#6b7280;white-space:nowrap}.actions{display:flex;align-items:center;gap:8px;white-space:nowrap}.act{color:#2563eb;text-decoration:none;font-size:12px}.act:hover{text-decoration:underline}.muted{color:#9ca3af;font-size:12px}.actions form{display:inline}.danger{border:1px solid #fecaca;background:#fff1f2;color:#b91c1c;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}.danger:hover{background:#ffe4e6}.empty{max-width:1100px;margin:40px auto;color:#9ca3af;text-align:center}.loading-overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(247,248,250,.86);z-index:9999;font-size:13px;color:#374151}.loading-overlay.show{display:flex}.spinner{width:28px;height:28px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div id="page-loading" class="loading-overlay"><div class="spinner"></div><div>正在加载项目设置…</div></div><a class="backbtn" href="/">← 返回 Harness</a><header><h1>MyReels Studio</h1><div class="sub">本地 run 状态；删除只清理本机文件，不删除 WebUI 故事台。 · <form method="post" action="/plugins/myreels-studio/logout" style="display:inline"><button type="submit" style="padding:2px 9px;border:1px solid #fecaca;border-radius:999px;background:#fff1f2;color:#b91c1c;font-size:12px;cursor:pointer">退出登录</button></form></div></header>${groups.length ? `<table><thead><tr><th>集</th><th>阶段</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">还没有任务。</div>'}<script>(()=>{const ov=document.getElementById('page-loading');const show=()=>ov.classList.add('show');document.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&String(a.getAttribute('href')||'').includes('project-settings'))show()});document.addEventListener('submit',()=>show())})();</script><script>function toggleProject(key){const heads=document.querySelectorAll('tr.grouphead');const target=document.querySelector('tr.grouphead[data-project="'+key+'"]');if(!target)return;const opening=!target.classList.contains('open');document.querySelectorAll('tr.eprow').forEach(r=>{r.style.display='none'});heads.forEach(h=>{h.classList.remove('open');const a=h.querySelector('.arrow');if(a)a.textContent='▸'});if(opening){target.classList.add('open');const a=target.querySelector('.arrow');if(a)a.textContent='▾';document.querySelectorAll('tr.eprow[data-project="'+key+'"]').forEach(r=>{r.style.display=''});heads.forEach(h=>{h.classList.remove('current');const c=h.querySelector('.curr');if(c)c.style.display='none'});target.classList.add('current');const bc=target.querySelector('.curr');if(bc)bc.style.display='inline-block'}}</script>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(page);
          return;
        }
        const localDelete = url.pathname.match(/^\/plugins\/myreels-studio\/runs\/([0-9a-f-]{8,})\/local$/i);
        if (localDelete && req.method === 'DELETE') {
          const allowed = await canAccessRunWithConfig(config, localDelete[1]);
          if (!allowed.ok) { sendJson(res, allowed.status || 404, { error: 'run not found' }); return; }
          sendJson(res, 200, deleteLocalRun(localDelete[1]));
          return;
        }
        const deleteTask = url.pathname.match(/^\/plugins\/myreels-studio\/runs\/([0-9a-f-]{8,})\/delete$/i);
        if (deleteTask && req.method === 'POST') {
          const allowed = await canAccessRunWithConfig(config, deleteTask[1]);
          if (!allowed.ok) { sendJson(res, allowed.status || 404, { error: 'run not found' }); return; }
          deleteLocalRun(deleteTask[1]);
          res.writeHead(302, { Location: '/plugins/myreels-studio/tasks' });
          res.end();
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/project-settings') {
          if (authStatus().loggedOut) {
            res.writeHead(302, { Location: '/plugins/myreels-studio/tasks?loggedOut=1' });
            res.end();
            return;
          }
          const base = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const projectId = String(url.searchParams.get('projectId') || '').trim();
          const embed = url.searchParams.get('embed') === '1';
          const fragment = url.searchParams.get('fragment') === '1';
          if (!projectId) {
            res.writeHead(302, { Location: '/plugins/myreels-studio/tasks' });
            res.end();
            return;
          }
          const ownsProject = listRuns().some((run) => run.projectId === projectId && localRunVisible(run, authStatus()));
          if (!ownsProject) {
            sendJson(res, 404, { error: 'project not found for current user' });
            return;
          }
          if (req.method === 'GET' && !fragment) {
            const shell = `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 项目设置</title><style>html,body{margin:0;height:100%;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937}.loading-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(247,248,250,.96);z-index:9999;font-size:13px;color:#374151}.spinner{width:28px;height:28px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="loading-overlay"><div class="spinner"></div><div id="shell-label">正在加载项目设置…</div></div><script>(async()=>{const label=document.getElementById('shell-label');try{const u=new URL(location.href);u.searchParams.set('fragment','1');const r=await fetch(u,{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw new Error('HTTP '+r.status);const html=await r.text();document.open();document.write(html);document.close()}catch(e){if(label)label.textContent='加载失败：'+(e.message||e)}})();</script>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(shell);
            return;
          }
          const token = await loginToken(base, credentialsOf(config));
          if (!token) {
            sendJson(res, 401, { error: 'missing credentials' });
            return;
          }
          if (req.method === 'POST') {
            const form = await readFormBody(req);
            const projectRes = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
            if (projectRes.status !== 200) {
              sendJson(res, projectRes.status, { error: 'project not readable' });
              return;
            }
            const metadata = { ...(projectRes.json?.data?.metadata || {}) };
            const tools = await loadStoryTools(base, token);
            const stringKeys = [
              'defaultVideoRatio', 'defaultImageRatio',
              'defaultCharacterRatio', 'defaultSceneRatio', 'defaultItemRatio', 'defaultCreatureRatio',
              'defaultCharacterTemplateSlug', 'defaultSceneTemplateSlug', 'defaultItemTemplateSlug', 'defaultCreatureTemplateSlug',
              'defaultCharacterVariantTemplateSlug', 'defaultSceneVariantTemplateSlug',
              'imageModelSlug', 'videoModelSlug', 'assetReview',
              'analysisReview', 'scriptAnalysisModelKey', 'scriptAnalyzerLlmGroup', 'scriptAnalyzerOutputLanguage', 'scriptAnalyzerAspectRatio',
            ];
            for (const key of stringKeys) {
              if (form.has(key)) metadata[key] = String(form.get(key) || '').trim();
            }
            if (form.has('imageModelSlug')) {
              const imageTool = tools.find((t) => String(t.slug || '') === String(metadata.imageModelSlug || ''));
              metadata.defaultImageModel = imageTool?.id ? String(imageTool.id) : '';
            }
            if (form.has('videoModelSlug')) {
              const videoTool = tools.find((t) => String(t.slug || '') === String(metadata.videoModelSlug || ''));
              // WebUI 的选项值优先用 modelName，modelName 为 {{model}} 时回退 slug。
              const optionValue = videoToolOptionValue(videoTool);
              // WebUI 以 defaultMultiVideoModel 为优先字段，defaultVideoModel 只作兼容；
              // 两个字段必须一起写，否则 WebUI 会继续显示旧模型。
              metadata.defaultMultiVideoModel = optionValue;
              metadata.defaultVideoModel = optionValue;
            }
            if (form.has('runBudgetPoints')) metadata.runBudgetPoints = Math.max(0, Number(form.get('runBudgetPoints')) || 0);
            if (form.has('scriptAnalyzerShotDurationSeconds')) metadata.scriptAnalyzerShotDurationSeconds = Math.max(1, Math.min(60, Number(form.get('scriptAnalyzerShotDurationSeconds')) || 30));
            if (form.has('scriptAnalyzerMaxShotsPerSegment')) metadata.scriptAnalyzerMaxShotsPerSegment = Math.max(0, Math.min(20, Number(form.get('scriptAnalyzerMaxShotsPerSegment')) || 0));
            if (form.has('scriptAnalyzerSpeechRate')) metadata.scriptAnalyzerSpeechRate = Math.max(1, Math.min(20, Number(form.get('scriptAnalyzerSpeechRate')) || 6));
            if (form.has('scriptAnalyzerIsDirectorScript')) metadata.scriptAnalyzerIsDirectorScript = String(form.get('scriptAnalyzerIsDirectorScript')) === 'true';
            if (form.has('imageParallelism')) metadata.imageParallelism = Math.max(1, Math.min(10, Number(form.get('imageParallelism')) || 10));
            if (form.has('videoParallelism')) metadata.videoParallelism = Math.max(1, Math.min(10, Number(form.get('videoParallelism')) || 1));
        if (form.has('analysisParallelism')) metadata.analysisParallelism = Math.max(1, Math.min(10, Number(form.get('analysisParallelism')) || 5));
            if (form.has('assetReview')) {
              const mode = String(form.get('assetReview') || 'manual');
              metadata.assetReview = ['manual', 'auto', 'off'].includes(mode) ? mode : 'manual';
              for (const name of readdirSync(stateDir()).filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))) {
                const state = readRunState(name.replace(/\.json$/, ''));
                if (!state || String(state.projectId || '') !== projectId) continue;
                writeRunState(state.runId, {
                  ...state,
                  settings: { ...(state.settings || {}), assetReview: metadata.assetReview },
                });
              }
            }
            if (form.has('stylePageId')) {
              const id = String(form.get('stylePageId') || '').trim();
              metadata.defaultStyleWikiPromptIds = id ? [id] : [];
              if (id) {
                const styles = await fetchStyleCandidates(base, token, 100).catch(() => []);
                const style = styles.find((s) => String(s.pageId) === id) || null;
                const currentStyle = metadata.defaultStyleWikiPrompt && typeof metadata.defaultStyleWikiPrompt === 'object'
                  ? metadata.defaultStyleWikiPrompt
                  : {};
                // WebUI 通过 pageId/title 还原画风；只写 promptTemplate 会识别不到。
                metadata.defaultStyleIgnored = false;
                metadata.defaultStyleWikiPrompt = {
                  ...currentStyle,
                  pageId: Number(id),
                  title: String(style?.title || currentStyle.title || `Wiki ${id}`),
                  category: String(currentStyle.category || ''),
                  promptTemplate: String(currentStyle.promptTemplate || ''),
                  variables: Array.isArray(currentStyle.variables) ? currentStyle.variables : [],
                };
              }
            }
            if (form.has('styleText')) {
              const styleText = String(form.get('styleText') || '');
              const currentStyle = metadata.defaultStyleWikiPrompt && typeof metadata.defaultStyleWikiPrompt === 'object'
                ? metadata.defaultStyleWikiPrompt
                : {};
              if (styleText.trim()) metadata.defaultStyleIgnored = false;
              metadata.defaultStyleWikiPrompt = {
                ...currentStyle,
                promptTemplate: styleText,
              };
            }
            metadata.harnessSettingsCompletedAt = new Date().toISOString();
            const saved = await putProjectMetadata(base, token, projectId, metadata);
            if (saved.status !== 200) {
              sendJson(res, saved.status, { error: 'save failed' });
              return;
            }
            res.writeHead(302, { Location: `/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(projectId)}&saved=1${embed ? '&embed=1' : ''}` });
            res.end();
            return;
          }
          const [projectRes, templates, styles, tools, analyzerTool] = await Promise.all([
            httpJson(`${base}/api/v1/story-projects/${projectId}`, { token }),
            listAssetTemplates(base, token).catch(() => []),
            fetchStyleCandidates(base, token, 30).catch(() => []),
            loadStoryTools(base, token),
            fetchAnalyzerTool(base, token).catch(() => null),
          ]);
          if (projectRes.status !== 200) {
            sendJson(res, projectRes.status, { error: 'project not readable' });
            return;
          }
          const project = projectRes.json?.data || {};
          const meta = project.metadata && typeof project.metadata === 'object' ? project.metadata : {};
          const typeLabels = { character: '角色', scene: '场景', item: '物品', creature: '生物' };
          const ratioKeys = { character: 'defaultCharacterRatio', scene: 'defaultSceneRatio', item: 'defaultItemRatio', creature: 'defaultCreatureRatio' };
          const tplKeys = { character: 'defaultCharacterTemplateSlug', scene: 'defaultSceneTemplateSlug', item: 'defaultItemTemplateSlug', creature: 'defaultCreatureTemplateSlug' };
          const templateFields = (() => {
            const select = (type, key, label) => {
              const options = templates.filter((t) => t.assetType === type);
              const current = String(meta[key] || '');
              const valueOf = (t) => String(t.id || t.slug || '');
              const matches = (t) => valueOf(t) === current || String(t.slug || '') === current;
              const opts = options.map((t) => `<option value="${htmlEscape(valueOf(t))}" ${matches(t) ? 'selected' : ''}>${htmlEscape(t.title || t.slug)}</option>`).join('');
              const currentOnly = current && !options.some(matches)
                ? `<option value="${htmlEscape(current)}" selected>当前模板（${htmlEscape(current)}）</option>`
                : '';
              return `<label>${label}<select name="${key}"><option value="">（使用主体模板 / 不指定）</option>${currentOnly}${opts}</select></label>`;
            };
            return [
              `<h3>角色</h3><div class="grid">${select('character', 'defaultCharacterTemplateSlug', '角色主体模板')}${select('character', 'defaultCharacterVariantTemplateSlug', '角色变体模板')}</div>`,
              `<h3>场景</h3><div class="grid">${select('scene', 'defaultSceneTemplateSlug', '场景主体模板')}${select('scene', 'defaultSceneVariantTemplateSlug', '场景变体模板')}</div>`,
              `<h3>物品 / 生物</h3><div class="grid">${select('item', 'defaultItemTemplateSlug', '物品模板')}${select('creature', 'defaultCreatureTemplateSlug', '生物模板')}</div>`,
            ].join('');
          })();
          const analyzerFields = (() => {
            const duration = Number(meta.scriptAnalyzerShotDurationSeconds || 30);
            const durationOptions = [15, 30, 60].map((value) => `<option value="${value}" ${Number(value) === duration ? 'selected' : ''}>${value}</option>`).join('');
            const language = String(meta.scriptAnalyzerOutputLanguage || 'zh');
            const languageOptions = [['ja', '日语'], ['zh', '中文'], ['en', '英文'], ['ko', '韩语']]
              .map(([value, label]) => `<option value="${value}" ${value === language ? 'selected' : ''}>${label}</option>`).join('');
            const aspect = String(meta.scriptAnalyzerAspectRatio || meta.defaultVideoRatio || '9:16');
            const aspectOptions = ['9:16', '16:9', '1:1'].map((value) => `<option value="${value}" ${value === aspect ? 'selected' : ''}>${value === '9:16' ? '竖屏 9:16' : value === '16:9' ? '横屏 16:9' : '方形 1:1'}</option>`).join('');
            const director = meta.scriptAnalyzerIsDirectorScript !== false;
            const review = String(meta.analysisReview || 'manual') === 'auto' ? 'auto' : 'manual';
            const reviewOptions = [['manual', '人工确认（默认）'], ['auto', '自动提交']]
              .map(([value, label]) => `<option value="${value}" ${value === review ? 'selected' : ''}>${label}</option>`).join('');
            const llmSchema = analyzerTool?.userInputSchema?.llm_group && typeof analyzerTool.userInputSchema.llm_group === 'object'
              ? analyzerTool.userInputSchema.llm_group
              : {};
            const llmOptions = Array.isArray(llmSchema.options) ? llmSchema.options : [];
            const currentLlmGroup = String(meta.scriptAnalyzerLlmGroup || llmSchema.default || 'group2');
            const llmOptionHtml = llmOptions.map((option) => {
              const value = String(option?.value ?? '').trim();
              const label = String(option?.label ?? value);
              return value
                ? `<option value="${htmlEscape(value)}" ${value === currentLlmGroup ? 'selected' : ''}>${htmlEscape(label)}</option>`
                : '';
            }).join('');
            const llmCurrentOnly = currentLlmGroup && !llmOptions.some((option) => String(option?.value) === currentLlmGroup)
              ? `<option value="${htmlEscape(currentLlmGroup)}" selected>当前模型：${htmlEscape(currentLlmGroup)}</option>`
              : '';
            return `<h2>剧本分析</h2><div class="hint">分析任务提交前默认需要人工确认；确认前只创建剧本，不扣分析任务。</div><div class="grid">`
              + `<label>每个分镜时长上限（秒）<select name="scriptAnalyzerShotDurationSeconds">${durationOptions}</select></label>`
              + `<label>每个分镜内最多镜头数<input type="number" name="scriptAnalyzerMaxShotsPerSegment" min="0" max="20" value="${Math.max(0, Number(meta.scriptAnalyzerMaxShotsPerSegment) || 0)}"></label>`
              + `<label>台词语速<input type="number" name="scriptAnalyzerSpeechRate" min="1" max="20" value="${Math.max(1, Number(meta.scriptAnalyzerSpeechRate) || 6)}"></label>`
              + `<label>是否导演剧本<select name="scriptAnalyzerIsDirectorScript"><option value="true" ${director ? 'selected' : ''}>是</option><option value="false" ${director ? '' : 'selected'}>否</option></select></label>`
              + `<label>分析模型<select name="scriptAnalyzerLlmGroup"><option value="">（使用默认）</option>${llmCurrentOnly}${llmOptionHtml}</select></label>`
              + `<label>输出语言<select name="scriptAnalyzerOutputLanguage">${languageOptions}</select></label>`
              + `<label>成片画幅<select name="scriptAnalyzerAspectRatio">${aspectOptions}</select></label>`
              + `<label>分析确认<select name="analysisReview">${reviewOptions}</select></label>`
              + `</div>`;
          })();
          const ratioOptions = ['9:16', '16:9', '3:4', '1:1'];
          const reviewMode = ['manual', 'auto', 'off'].includes(String(meta.assetReview || '')) ? String(meta.assetReview) : 'manual';
          const reviewOptions = [['manual', '人工确认（默认）'], ['auto', '自动确认'], ['off', '不审查']]
            .map(([value, label]) => `<option value="${value}" ${value === reviewMode ? 'selected' : ''}>${label}</option>`).join('');
          const ratioFields = Object.keys(typeLabels).map((type) => {
            const current = String(meta[ratioKeys[type]] || '');
            const opts = ratioOptions.map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${r}</option>`).join('');
            return `<label>${typeLabels[type]}比例<select name="${ratioKeys[type]}">${opts}</select></label>`;
          }).join('');
          const videoRatios = ratioOptions.map((r) => `<option value="${r}" ${r === String(meta.defaultVideoRatio || '') ? 'selected' : ''}>${r}</option>`).join('');
          const styleIgnored = meta.defaultStyleIgnored === true;
          const styleId = !styleIgnored && Array.isArray(meta.defaultStyleWikiPromptIds) ? (meta.defaultStyleWikiPromptIds[0] || '') : '';
          const styleOptions = styles.map((s) => `<option value="${htmlEscape(s.pageId)}" ${String(s.pageId) === String(styleId) ? 'selected' : ''}>${htmlEscape(s.title || s.pageId)}</option>`).join('');
          const styleSelected = styles.some((s) => String(s.pageId) === String(styleId));
          const styleFallback = styleId && !styleSelected ? `<option value="${htmlEscape(styleId)}" selected>${htmlEscape(styleId)}（当前）</option>` : '';
          const imageTools = tools.filter((tool) => Array.isArray(tool.tags) && tool.tags.includes('s2i'));
          const videoTools = tools.filter((tool) => (
            String(tool.displayConfig?.resourceType || '') === 'general'
            && String(tool.displayConfig?.subCategory || '') === 'video_tool'
            && Array.isArray(tool.tags)
            && tool.tags.some((tag) => ['t2v', 'i2v'].includes(String(tag)))
          ));
          const modelName = (model) => String(model?.name || model?.modelName || '');
          const modelSort = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
          const imageModels = modelOptionsFromTools(imageTools, 'image').list
            .sort((a, b) => modelSort.compare(modelName(a), modelName(b)));
          const videoModels = modelOptionsFromTools(videoTools, 'video').list
            .sort((a, b) => modelSort.compare(modelName(a), modelName(b)));
          const webuiImageTool = findImageTool(tools, meta);
          const webuiVideoTool = findVideoTool(tools, meta);
          const currentImageSlug = String(webuiImageTool?.slug || meta.imageModelSlug || '');
          const currentVideoSlug = String(webuiVideoTool?.slug || meta.videoModelSlug || '');
          const modelSelect = (list, key, current, label) => {
            const opts = list.map((m) => {
              const value = String(m.slug || m.modelName || '');
              const selected = value === current || String(m.modelName || '') === current;
              return `<option value="${htmlEscape(value)}" ${selected ? 'selected' : ''}>${htmlEscape(m.name || m.modelName || value)}${m.cost ? `（${m.cost} 点）` : ''}</option>`;
            }).join('');
            return `<label>${label}<select name="${key}"><option value="">（默认）</option>${opts}</select></label>`;
          };
          const ratioSelect = (key, label, current) => {
            const opts = ratioOptions.map((r) => `<option value="${r}" ${r === String(current || '') ? 'selected' : ''}>${r}</option>`).join('');
            return `<label>${label}<select name="${key}"><option value="">（未设）</option>${opts}</select></label>`;
          };
          const savedFlag = url.searchParams.get('saved') === '1';
          const imageParallelism = Math.max(1, Math.min(10, Number(meta.imageParallelism) || 10));
          const videoParallelism = Math.max(1, Math.min(10, Number(meta.videoParallelism) || 3));
  const analysisParallelism = Math.max(1, Math.min(10, Number(meta.analysisParallelism) || 5));
          const page = `<!doctype html><meta charset="utf-8"><title>MyReels Studio · 项目设置</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;padding:${embed ? '12px 16px 16px' : '62px 20px 20px'};max-width:1040px;margin:0 auto}.topbar{position:fixed;top:14px;left:14px;z-index:100;display:flex;gap:8px}.backbtn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#2563eb;text-decoration:none;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.backbtn:hover{background:#eff6ff}h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:5px}h3{font-size:12px;color:#374151;margin:10px 0 6px}.hint{font-size:11px;line-height:1.55;color:#6b7280;margin:12px 0 10px}.sub{color:#6b7280;font-size:12px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.ratio-grid{margin-top:16px;grid-template-columns:repeat(6,minmax(0,1fr))}.half{max-width:50%;min-width:160px}label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#374151}input,select,textarea{padding:6px 8px;border:1px solid #d1d5db;border-radius:7px;background:#fff;color:#111827;font-size:12px}textarea{min-height:52px;resize:vertical}.save{margin-top:0;padding:8px 16px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}.form-actions{display:flex;justify-content:flex-end;margin-top:14px}.ok{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;padding:8px;border-radius:7px;margin-bottom:10px}.loading-overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(247,248,250,.88);z-index:9999;font-size:13px;color:#374151}.loading-overlay.show{display:flex}.spinner{width:28px;height:28px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>${embed ? '' : '<div class="topbar"><a class="backbtn" href="/plugins/myreels-studio/tasks">← 返回任务列表</a><form method="post" action="/plugins/myreels-studio/logout" style="margin-left:auto"><button type="submit" style="padding:8px 14px;border:1px solid #fecaca;border-radius:8px;background:#fff1f2;color:#b91c1c;font-size:13px;cursor:pointer">退出登录</button></form></div>'}<h1>${htmlEscape(project.title || projectId)}</h1><div class="sub">项目设置 · ${htmlEscape(projectId)}</div>${savedFlag ? '<div class="ok">已保存</div>' : ''}<form method="post" action="/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(projectId)}${embed ? '&embed=1' : ''}"><input type="hidden" name="projectId" value="${htmlEscape(projectId)}"><h2>默认模型</h2><div class="grid">${modelSelect(imageModels, 'imageModelSlug', currentImageSlug, '默认图片模型')}${modelSelect(videoModels, 'videoModelSlug', currentVideoSlug, '默认视频模型')}</div><h2>并行数量</h2><div class="grid"><label>图片并行数<input type="number" name="imageParallelism" min="1" max="10" value="${imageParallelism}"></label><label>视频并行数<input type="number" name="videoParallelism" min="1" max="10" value="${videoParallelism}"></label><label>分析并行数<input type="number" name="analysisParallelism" min="1" max="10" value="${analysisParallelism}"></label></div><div class="hint">控制单次批量提交上限；默认图片 10、分析 5、视频 3，过高会增加排队和签名 URL 过期风险。</div><h2>画风与比例</h2><div class="grid"><label class="half">画风模板<select name="stylePageId"><option value="">（不指定）</option>${styleFallback}${styleOptions}</select></label></div><div class="grid ratio-grid">${ratioSelect('defaultCharacterRatio', '角色比例', meta.defaultCharacterRatio)}${ratioSelect('defaultSceneRatio', '场景比例', meta.defaultSceneRatio)}${ratioSelect('defaultItemRatio', '道具比例', meta.defaultItemRatio)}${ratioSelect('defaultCreatureRatio', '生物比例', meta.defaultCreatureRatio)}${ratioSelect('defaultImageRatio', '默认片段比例', meta.defaultImageRatio)}${ratioSelect('defaultVideoRatio', '默认视频比例', meta.defaultVideoRatio)}</div><h2>基础</h2><div class="grid"><label class="half">预算点数<input type="number" name="runBudgetPoints" min="0" value="${htmlEscape(meta.runBudgetPoints || 0)}"></label><label class="half">资产审查模式<select name="assetReview">${reviewOptions}</select></label></div><div class="hint">人工确认：生成资产图前必须先用 myreels_asset_audit 审查提示词/参考图并 confirm；自动确认会跳过人工等待。</div>${analyzerFields}<h2>默认资产模板</h2><div class="hint">主体图使用主体模板；变体图优先使用变体模板，留空则回退主体模板。</div>${templateFields}${embed ? '' : '<div class="form-actions"><button class="save" type="submit">保存设置</button></div>'}</form><div id="page-loading" class="${fragment ? 'loading-overlay' : 'loading-overlay show'}"><div class="spinner"></div><div id="loading-label">正在加载项目设置…</div></div><script>(()=>{const ov=document.getElementById('page-loading');const label=document.getElementById('loading-label');const form=document.querySelector('form');requestAnimationFrame(()=>setTimeout(()=>ov.classList.remove('show'),350));window.addEventListener('message',event=>{if(event&&event.data&&event.data.type==='myreels-save-project-settings'){const form=document.querySelector('form');if(form)form.requestSubmit()}});if(form)form.addEventListener('submit',()=>{if(label)label.textContent='正在保存设置…';ov.classList.add('show')})})();</script>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(page);
          return;
        }
        if (url.pathname === '/plugins/myreels-studio/autonomy') {
          if (authStatus().loggedOut) { sendJson(res, 401, { error: 'logged out' }); return; }
          if (req.method === 'GET') { sendJson(res, 200, autonomyStatus()); return; }
          if (req.method === 'POST') {
            try {
              const body = await readJsonBody(req);
              sendJson(res, 200, setAutonomy(body));
            } catch (error) {
              sendJson(res, 400, { error: String(error?.message || error), ...autonomyStatus() });
            }
            return;
          }
        }
        if (url.pathname === '/plugins/myreels-studio/runs') {
          let auth = authStatus();
          const loginBaseUrl = String(configOf(config).webBaseUrl || '').replace(/\/+$/, '');
          if (auth.loggedOut) {
            sendJson(res, 200, { runs: [], projects: [], auth, webBaseUrl: loginBaseUrl, autonomy: autonomyStatus() });
            return;
          }
          const base = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const profileBase = (authStatus().apiBaseUrl || configOf(config).authBaseUrl || base).replace(/\/+$/, '');
          const token = await withTimeout(loginToken(base, credentialsOf(config)), 3000, '');
          let profile = null;
          let pointsBalance = null;
          let remoteProjects = [];
          const tokenPayload = readJwtPayload(token);
          const isSubaccount = auth.isSubaccount
            || String(tokenPayload?.provider || '') === 'subaccount'
            || String(tokenPayload?.operatorType || '') === 'subaccount';
          if (token && isSubaccount) {
            const [projectsRes, subRes] = await withTimeout(Promise.all([
              listRemoteProjects(base, token),
              httpJson(`${profileBase}/api/v1/subaccounts/me`, { token, apiKey: configOf(config).publicApiKey || '' }).catch(() => null),
            ]), 3000, [[], null]);
            remoteProjects = Array.isArray(projectsRes) ? projectsRes : [];
            const subList = Array.isArray(subRes?.json?.data?.items)
              ? subRes.json.data.items
              : (Array.isArray(subRes?.json?.data) ? subRes.json.data : []);
            const wantedSubaccountId = String(auth.operatorSubaccountId ?? '');
            const sub = subList.find((item) => String(item?.id ?? '') === wantedSubaccountId)
              || subRes?.json?.data?.subaccount
              || (subList.length === 1 ? subList[0] : {});
            const subError = String(subRes?.json?.error?.code || subRes?.json?.message || '');

            if (subRes?.status === 401 && /oauth|session|token/i.test(subError)) {
              logoutAuthSession();
              auth = authStatus();
              sendJson(res, 200, { runs: [], projects: [], auth, profile: null, pointsBalance: null, webBaseUrl: loginBaseUrl, autonomy: autonomyStatus() });
              return;
            }
            if (sub && (sub.id || sub.loginName || sub.displayName)) {
              const quota = Number(sub.monthlyQuotaPoints ?? sub.monthly_quota_points ?? 0);
              const used = Number(sub.usedPointsCurrentMonth ?? sub.used_points_current_month ?? 0);
              const weeklyQuota = Number(sub.weeklyQuotaPoints ?? sub.weekly_quota_points ?? 0);
              const weeklyUsed = Number(sub.usedPointsCurrentWeek ?? sub.used_points_current_week ?? 0);
              const monthlyRemaining = quota > 0 ? Math.max(0, quota - used) : null;
              const weeklyRemaining = weeklyQuota > 0 ? Math.max(0, weeklyQuota - weeklyUsed) : null;
              profile = {
                userId: String(sub.parentUserId ?? sub.parent_user_id ?? tokenPayload?.tenantUserId ?? auth.userId ?? ''),
                username: String(sub.loginName ?? sub.login_name ?? sub.username ?? ''),
                displayName: String(sub.displayName ?? sub.display_name ?? sub.username ?? ''),
                avatarUrl: String(sub.avatarUrl ?? sub.avatar_url ?? ''),
                isSubaccount: true,
                operatorSubaccountId: sub.id ?? null,
                subaccountPublicCode: String(sub.subaccountPublicCode ?? sub.subaccount_public_code ?? ''),
                quota: {
                  monthlyQuota: quota,
                  monthlyUsed: used,
                  monthlyRemaining,
                  weeklyQuota,
                  weeklyUsed,
                  weeklyRemaining,
                },
              };
              pointsBalance = monthlyRemaining;
            }
          } else if (token) {
            const [projectsRes, profileRes, balanceRes] = await withTimeout(Promise.all([
              listRemoteProjects(base, token),
              httpJson(`${profileBase}/api/v1/users/me`, { token, apiKey: configOf(config).publicApiKey || '' }).catch(() => null),
              httpJson(`${profileBase}/api/v1/users/balance`, { token, apiKey: configOf(config).publicApiKey || '' }).catch(() => null),
            ]), 3000, [[], null, null]);
            remoteProjects = Array.isArray(projectsRes) ? projectsRes : [];
            const u = profileRes?.json?.data;
            if (u) {
              profile = {
                userId: u.id ?? null,
                username: String(u.username || ''),
                displayName: String(u.display_name || u.displayName || ''),
                avatarUrl: u.avatar_url || u.avatarUrl || '',
              };
            }
            const profileError = String(profileRes?.json?.error?.code || profileRes?.json?.message || '');
            if (profileRes?.status === 401 && /oauth|session|token/i.test(profileError)) {
              logoutAuthSession();
              auth = authStatus();
              sendJson(res, 200, { runs: [], projects: [], auth, profile: null, pointsBalance: null, webBaseUrl: loginBaseUrl, autonomy: autonomyStatus() });
              return;
            }
            const b = balanceRes?.json?.data;
            if (b) {
              const raw = b.total_points ?? b.totalPoints ?? b.points_balance ?? b.pointsBalance;
              const parsed = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
              pointsBalance = Number.isFinite(parsed) ? parsed : null;
            }
          }
          if (!profile && auth.userId) {
            const fallbackName = auth.isSubaccount
              ? (auth.operatorLabel || auth.username)
              : auth.username;
            profile = {
              userId: auth.userId,
              username: fallbackName,
              displayName: auth.isSubaccount ? (auth.operatorLabel || '') : '',
              avatarUrl: '',
              ...(auth.isSubaccount ? { isSubaccount: true, operatorSubaccountId: auth.operatorSubaccountId } : {}),
            };
          }
          // Local run ownership is keyed by the authenticated tenant user, not
          // by the parent user of a subaccount profile.
          const viewer = { userId: String(auth.userId || profile?.userId || ''), username: String(profile?.username || auth.username || '') };
          let visibleRuns = viewer.userId
            ? listRuns().filter((run) => localRunVisible(run, auth))
            : [];
          const includeDeleted = url.searchParams.get('includeDeleted') === '1'
            || url.searchParams.get('includeDeleted') === 'true';
          if (!includeDeleted && token) {
            visibleRuns = await filterRunsByBackendProject(base, token, visibleRuns);
          }
          const visibleProjectIds = new Set(visibleRuns.map((run) => String(run.projectId || '')).filter(Boolean));
          const visibleProjects = remoteProjects.filter((project) => (
            visibleProjectIds.has(String(project.projectId || ''))
            || (project.ownerKey && String(project.ownerKey) === String(auth.ownerKey || ''))
          ));
          sendJson(res, 200, { runs: visibleRuns, projects: visibleProjects, auth, profile, pointsBalance, webBaseUrl: loginBaseUrl, autonomy: autonomyStatus() });
          return;
        }
        const match = url.pathname.match(/^\/plugins\/myreels-studio\/runs\/([A-Za-z0-9-]+)$/);
        if (match) {
          if (authStatus().loggedOut) { sendJson(res, 401, { error: 'logged out' }); return; }
          try {
            const detailBase = (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
            const detailToken = await loginToken(detailBase, credentialsOf(config));
            let detailViewer = { userId: String(authStatus().userId || ''), username: String(authStatus().username || '') };
            if (detailToken) {
              const meRes = await httpJson(`${detailBase}/api/v1/users/me`, { token: detailToken, apiKey: configOf(config).publicApiKey || '' }).catch(() => null);
              const me = meRes?.json?.data || meRes?.json || {};
              // Keep the authenticated tenant identity for local run ownership;
              // a subaccount profile points at its parent user and must not
              // replace the local owner id used by run states.
              detailViewer = {
                userId: detailViewer.userId || String(me.id ?? ''),
                username: String(me.username || detailViewer.username || ''),
              };
            }
            const allowed = await canViewRun(detailBase, detailToken, detailViewer, match[1]);
            if (!allowed.ok) { sendJson(res, allowed.status || 404, { error: 'run not found' }); return; }
            const detail = await runDetail(config, match[1]);
            if (!detail) sendJson(res, 404, { error: 'run not found' });
            else sendJson(res, 200, detail);
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message || error) });
          }
          return;
        }
        const reportMatch = url.pathname.match(/^\/plugins\/myreels-studio\/report\/([A-Za-z0-9-]+)$/);
        if (reportMatch) {
          if (authStatus().loggedOut) { sendJson(res, 401, { error: 'logged out' }); return; }
          const reportAccess = await checkRunAccess(config, reportMatch[1]);
          if (!reportAccess.ok) { sendJson(res, reportAccess.status || 404, { error: 'run not found' }); return; }
          const file = reportPathOf(reportMatch[1]);
          if (!existsSync(file)) {
            sendJson(res, 404, { error: 'report not generated', hint: 'run myreels_report first' });
            return;
          }
          sendJson(res, 200, { path: file, content: readFileSync(file, 'utf8') });
          return;
        }
        const mediaMatch = url.pathname.match(/^\/plugins\/myreels-studio\/media\/([A-Za-z0-9-]+)\.mp4$/);
        if (mediaMatch) {
          if (authStatus().loggedOut) { sendJson(res, 401, { error: 'logged out' }); return; }
          const mediaAccess = await checkRunAccess(config, mediaMatch[1]);
          if (!mediaAccess.ok) { sendJson(res, mediaAccess.status || 404, { error: 'run not found' }); return; }
          const state = readRunState(mediaMatch[1]);
          const file = state?.renderPath;
          if (!file || !existsSync(file)) {
            sendJson(res, 404, { error: 'render not found', hint: 'run myreels_render first' });
            return;
          }
          const size = statSync(file).size;
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          const range = String(req.headers.range || '');
          if (range.startsWith('bytes=')) {
            const [rawStart, rawEnd] = range.replace('bytes=', '').split('-');
            const start = Number(rawStart) || 0;
            const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
            if (start >= size || end < start) {
              res.statusCode = 416;
              res.setHeader('Content-Range', `bytes */${size}`);
              res.end();
              return;
            }
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            res.setHeader('Content-Length', end - start + 1);
            res.end(readFileSync(file).subarray(start, end + 1));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Length', size);
          res.end(readFileSync(file));
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
    });
    return () => dispose();
  });
}

export function apply(ctx, config) {
  let workingDirectoryService = null;
  ctx.inject(['workingDirectory'], (sctx) => {
    workingDirectoryService = sctx.workingDirectory;
    return () => { workingDirectoryService = null; };
  });
  ctx.inject(['workspaceRegistry'], (sctx) => {
    try {
      const workspace = sctx.workspaceRegistry?.list?.()[0];
      if (workspace?.path) setRuntimeWorkspaceDir(workspace.path);
    } catch { /* registry is optional */ }
    return () => {};
  });
  setRuntimeWorkspaceResolver(() => {
    const agent = toolExecutionStorage.getStore()?.agent;
    try {
      if (agent?.session && workingDirectoryService?.get) return workingDirectoryService.get(agent.session);
    } catch { /* use registry below */ }
    return '';
  });

  for (const factory of TOOL_FACTORIES) {
    ctx.inject(['tools'], (sctx) => {
      const tool = factory(config);
      const originalExecute = tool.execute.bind(tool);
      const wrapped = {
        ...tool,
        execute(args, exec) {
          const requestedRunId = String(args?.runId || '').trim();
          if (requestedRunId) {
            const requestedState = readRunState(requestedRunId);
            if (requestedState && !localRunVisible(requestedState, authStatus())) {
              throw new Error('该 run 不属于当前操作者，已拒绝访问');
            }
          }
          return toolExecutionStorage.run({ agent: exec?.agent }, () => originalExecute(args, exec));
        },
      };
      const dispose = sctx.tools.register(wrapped);
      return () => dispose();
    });
  }

  registerPanelRoutes(ctx, config);

  ctx.inject(['systemPrompt'], (sctx) => {
    const disposeSection = sctx.systemPrompt.section({
      name: PLUGIN_ID,
      order: 500,
      text: [
        '[MyReels Studio] 插件已加载。',
        '工具：myreels_env_check / myreels_plan / myreels_settings / myreels_templates / myreels_run_start / myreels_run_status / myreels_run_confirm / myreels_run_advance / myreels_review_mode / myreels_review_items / myreels_script_split / myreels_script_check / myreels_script_fidelity / myreels_episode_add / myreels_episode_batch / myreels_wait / myreels_analysis_retry / myreels_analysis_confirm / myreels_runs / myreels_runs_claim / myreels_snapshot / myreels_preflight / myreels_segments / myreels_shot_audit / myreels_shot_split / myreels_asset_add / myreels_asset_main / myreels_asset_audit / myreels_coverage / myreels_auto / myreels_render / myreels_report / myreels_subtitle / myreels_refcheck / myreels_assetcheck / myreels_assetfix / myreels_shotfix / myreels_preview / myreels_logout / myreels_autonomy / myreels_rules / myreels_storage / myreels_project_open。',
        '约束：未确认画风/画幅/预算前不得提交分析；不要直连生成服务。',
        '多集：script_split 拆集 → run_start(首集) → wait → 本集资产/分镜/成片 → episode_add(下一集，自动继承设置) → wait；前集分析未完成时 episode_add 会拒绝。批量分析：script_split 后调用 episode_batch（或 episodes 列表），按项目设置 analysisParallelism（默认 5，最高 10）并发提交多集分析；batch 只负责提交，不等待，之后逐集 wait 和推进。',
        '剧本格式：script_check classify 判导演本/普通本；导演本一个分镜N=一个视频（默认按原始分镜时长一次生成，不默认拆段；只有模型单段上限不足且用户明确要求时才用 shot_split）；普通本不写分镜/时间码，用 第N集+【场】+人物+△动作+角色台词。',
        '生成前：script_fidelity 验剧情/台词/场景未变；myreels_asset_audit 输出完整资产/变体提示词、描述、参考图、分镜引用，Harness 必须结合剧本逐项判断准确性、参考素材是否足够，不要依赖固定字数/关键词规则；修改用 assetfix，确认时传 confirm=true + reviewNotes；manual 模式确认后才能生成资产。',
      '视频模型：默认使用项目设置视频模型；myreels_run_advance 可通过 videoModelSlug 显式指定其他可用模型，显式切换是允许的，但不会自动切换；H3 的提示词优化参数固定选自动（h3_video）；图片/视频并行数读取项目设置 imageParallelism（默认10）、videoParallelism（默认3），run_advance 按项目级并发上限排队；分镜超过模型单段上限时阻止下单并提示拆短。',
      '状态与渲染：分镜完成只认 latestVideo 且有 url/userFileId；缺失分镜的渲染只输出 *.partial.mp4，不得覆盖正式成片；同一分镜的 H3 任务在跑时不要重复提交，插件会记录 shotTasks 并阻止重复扣点。',
      '分析重试：myreels_wait 遇到 R2/SSL 等传输失败会自动重提最多 2 次；空壳“生物”占位资产在审查中按提醒跳过，不再阻断。', 
'分析完成后：myreels_wait 会返回 earlyWarnings，提前指出“分镜时长超过当前模型单段上限”和“台词在分镜时长内说不完”；有警告时先换模型/拆镜/shotfix，再进入资产和分镜生成。myreels_auto 在生成前也会自动 preflight（preflight_gate 开启时）。',
      '登录态：myreels_logout 只清除插件本地登录态，不会退出 MyReels 网页登录，也不删除项目或成片。重新登录通过 MyReels SSO 完成。',
      '产物目录：myreels_storage get 查看当前产物根目录（默认 <workspace>/myreels-runs），set 可改（workspaceDir / runsRoot）；成片路径为 <root>/<剧名>/epNN/epNN.mp4；state 注册表仍在 ~/.dsh/storages/myreels-studio。',
      '接入既有项目：myreels_project_open list=true 列当前登录用户的故事项目，按 projectId 或剧名（如「双向伪装」）接入某一集，得到 runId 后 snapshot / asset_audit / run_advance / render / report / preview 照常使用；同项目同集默认复用已有 run，不重复建。',
'自主优化：全局开关由 myreels_autonomy 管理。默认开启：script_format_detect（识别导演本/普通本）、director_script_convert（导演本转换与校验）、normal_script_convert（普通本转换与校验）、script_fidelity_guard（剧本优化保真校验）、analysis_blockers（修复分析阻断项）、shot_prompt_optimize（优化分镜提示词）、shot_duration_fit（分镜时长与台词匹配）、asset_reference_audit（审查资产素材引用）、asset_reference_repair（补齐资产参考图）、asset_prompt_repair（修正资产提示词）、preflight_gate（生成前预检）、transient_retry（传输失败重试）、auto_generation_retry（生成失败重试）、auto_render（完成后自动渲染）、auto_report（自动生成报告）、auto_preview（自动刷新预览）；默认关闭：duplicate_cleanup（重复 run 归档）、visual_asset_check（视觉一致性检查）。budget_fixed 固定开启不可关闭。用户说“关闭/开启某个自主优化”时调用 myreels_autonomy set；执行任何自主修复前先 list，关闭项不要自动执行，只提示用户可手动处理。',
      '审阅优化：myreels_review_items 读取某集 deliveryReview 的 review_items / quality_suggestions；按 shotNo/blockNo 判断问题，优先用 shotfix 修分镜提示词，涉及剧情/事实的再回剧本重分析；不要只读摘要，要逐项处理 blocking 项。',
        '原则：尽量由 Harness 决策并执行；常规修复（补图、接引用、改词、重试）直接做；默认保留原始分镜长度，不主动拆段。尽早确认：①超预算/大额生成 ②改剧情/台词/人物关系 ③对外发布。可自主：删除资产/分镜、跨集批量、多剧并行（操作前留痕、可回滚，完成后报告）。',
        '执行边界：代码只保留平台硬约束（模型存在性、数量/时长上限、预算闸门、资产模板），不固化创作流程；出错时优先自动修复并留痕。',
        '资产模板+比例：生成角色/场景/物品/生物前，必须已选模板并写入比例；myreels_templates set 会按模板名自动推荐比例，缺任一不得生成；生成时按类型各用各的比例；模板布局默认不自动追加，需要四视图时显式 layout=template。',
      ].join('\n'),
    });
    const disposeContext = sctx.systemPrompt.context({
      name: 'myreels-active-runs',
      order: 600,
      text: () => activeRunsText(),
    });
    return () => {
      disposeSection();
      disposeContext();
    };
  });
}


