import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { httpJson } from './http.js';

const AUTH_STATE_PATH = join(homedir(), '.dsh', 'storages', 'myreels-studio', 'auth.json');
let refreshRequest = null;

function readAuthSession() {
  try {
    const parsed = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAuthSession(patch) {
  const next = { ...readAuthSession(), ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(AUTH_STATE_PATH), { recursive: true });
  writeFileSync(AUTH_STATE_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function operatorKeyOf(session = readAuthSession()) {
  const isSubaccount = session.operatorType === 'subaccount' || Boolean(session.isSubaccount);
  if (isSubaccount && session.operatorSubaccountId !== null && session.operatorSubaccountId !== undefined && String(session.operatorSubaccountId) !== '') {
    return `sub:${String(session.operatorSubaccountId)}`;
  }
  return session.userId ? `user:${String(session.userId)}` : '';
}

export function authStatus() {
  const session = readAuthSession();
  const tokenPayload = decodeJwt(session.accessToken) || {};
  const tokenProvider = String(tokenPayload.provider || session.provider || '');
  return {
    loggedOut: session.loggedOut === true,
    hasToken: Boolean(session.accessToken),
    provider: tokenProvider,
    tokenProvider,
    apiBaseUrl: String(session.apiBaseUrl || ''),
    operatorType: String(session.operatorType || 'user'),
    operatorSubaccountId: session.operatorSubaccountId ?? null,
    operatorLabel: String(session.operatorLabel || ''),
    authenticatedUserId: session.authenticatedUserId ?? null,
    isSubaccount: session.operatorType === 'subaccount' || Boolean(session.isSubaccount),
    ownerKey: operatorKeyOf(session),
    userId: String(session.userId || ''),
    username: String(session.username || ''),
  };
}

export function logoutAuthSession() {
  return writeAuthSession({
    loggedOut: true,
    accessToken: '',
    refreshToken: '',
    provider: '',
    apiBaseUrl: '',
    operatorType: '',
    operatorSubaccountId: null,
    operatorLabel: '',
    authenticatedUserId: null,
    isSubaccount: false,
    userId: '',
    username: '',
  });
}

export function resumeAuthSession() {
  return writeAuthSession({ loggedOut: false, oauthState: '' });
}

export function beginOAuthLogin() {
  const state = randomUUID();
  writeAuthSession({ loggedOut: true, oauthState: state, oauthStartedAt: new Date().toISOString() });
  return state;
}

export function consumeOAuthState(state) {
  const session = readAuthSession();
  const expected = String(session.oauthState || '');
  if (!state || !expected || state !== expected) return false;
  writeAuthSession({ oauthState: '' });
  return true;
}

export function saveOAuthSession({ accessToken, refreshToken, userId, username, provider, apiBaseUrl, operatorType, operatorSubaccountId, operatorLabel, authenticatedUserId }) {
  if (!accessToken) return false;
  writeAuthSession({
    loggedOut: false,
    oauthState: '',
    accessToken: String(accessToken),
    refreshToken: String(refreshToken || ''),
    userId: String(userId || ''),
    username: String(username || ''),
    provider: String(provider || 'myreels'),
    apiBaseUrl: String(apiBaseUrl || '').replace(/\/+$/, ''),
    operatorType: String(operatorType || 'user'),
    operatorSubaccountId: operatorSubaccountId ?? null,
    operatorLabel: String(operatorLabel || ''),
    authenticatedUserId: authenticatedUserId ?? null,
    isSubaccount: operatorType === 'subaccount',
  });
  return true;
}

function tokenExpiresSoon(token, skewSeconds = 120) {
  const payload = decodeJwt(token);
  const exp = Number(payload?.exp || 0);
  if (!exp) return false;
  return exp * 1000 <= Date.now() + skewSeconds * 1000;
}

/**
 * Refresh the plugin's independent OAuth session. The platform rotates the
 * refresh token, so the new pair must be persisted immediately.
 */
export async function refreshOAuthSession(base, apiKey = '') {
  if (refreshRequest) return refreshRequest;
  refreshRequest = (async () => {
    const session = readAuthSession();
    const refreshToken = String(session.refreshToken || '');
    if (!refreshToken || !base) return '';
    const url = `${String(session.apiBaseUrl || base).replace(/\/+$/, '')}/api/v1/refreshtoken`;
    const response = await httpJson(url, {
      method: 'POST',
      body: { refreshToken },
      apiKey,
    }).catch(() => null);
    const data = response?.json?.data || {};
    const accessToken = String(data.accessToken || '');
    if (!accessToken) return '';
    writeAuthSession({
      loggedOut: false,
      accessToken,
      refreshToken: String(data.refreshToken || refreshToken),
      apiBaseUrl: String(session.apiBaseUrl || base).replace(/\/+$/, ''),
    });
    return accessToken;
  })();
  try {
    return await refreshRequest;
  } finally {
    refreshRequest = null;
  }
}

export function credentialsOf(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  return { apiKey: cfg.publicApiKey || cfg.apiKey || '' };
}

export function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Return the current plugin session token, refreshing it when it is close to
 * expiry. SSO login is the only supported login path.
 */
export async function loginToken(base, creds) {
  const session = readAuthSession();
  if (session.loggedOut === true) return '';
  if (session.refreshToken && (!session.accessToken || tokenExpiresSoon(session.accessToken))) {
    const refreshed = await refreshOAuthSession(base, creds?.apiKey || '');
    if (refreshed) return refreshed;
  }
  return session.accessToken ? String(session.accessToken) : '';
}

export async function withAuthRetry(base, creds, run) {
  const token = await loginToken(base, creds);
  if (!token) return { status: 401, json: null, text: 'login required' };
  let result = await run(token);
  if (result?.status === 401) {
    const refreshed = await refreshOAuthSession(base, creds?.apiKey || '');
    if (refreshed) result = await run(refreshed);
  }
  return result;
}
