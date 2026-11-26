import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { authStatus, operatorKeyOf } from './auth.js';
import { httpJson } from './http.js';
import { stateDir } from './state.js';

/** 当前登录用户的稳定身份；OAuth 登录直接读 auth.json，旧密码登录回退 /users/me。 */
export async function resolveOwner(base, token) {
  const session = authStatus();
  if (session.userId) {
    return {
      userId: String(session.userId),
      username: String(session.username || ''),
      ownerKey: session.ownerKey || operatorKeyOf(session),
      ownerType: String(session.operatorType || 'user'),
      ownerSubaccountId: session.operatorSubaccountId ?? null,
      ownerLabel: String(session.operatorLabel || session.username || ''),
      tokenProvider: String(session.tokenProvider || session.provider || ''),
    };
  }
  if (!token) return { userId: '', username: '', ownerKey: '', ownerType: 'user', ownerSubaccountId: null, ownerLabel: '', tokenProvider: '' };
  const r = await httpJson(`${base}/api/v1/users/me`, { token }).catch(() => null);
  const u = r?.json?.data || r?.json || {};
  return {
    userId: String(u.id ?? u.userId ?? ''),
    username: String(u.username || u.email || ''),
    ownerKey: u.id || u.userId ? `user:${String(u.id ?? u.userId)}` : '',
    ownerType: 'user',
    ownerSubaccountId: null,
    ownerLabel: String(u.username || u.email || ''),
    tokenProvider: '',
  };
}

export function ownerFields(owner) {
  const value = owner && typeof owner === 'object' ? owner : {};
  return {
    ownerUserId: String(value.userId || ''),
    ownerUsername: String(value.ownerLabel || value.operatorLabel || value.username || ''),
    ownerKey: String(value.ownerKey || ''),
    ownerType: String(value.ownerType || value.operatorType || 'user'),
    ownerSubaccountId: value.ownerSubaccountId ?? value.operatorSubaccountId ?? null,
    ownerLabel: String(value.ownerLabel || value.operatorLabel || value.username || ''),
  };
}

/**
 * Local run visibility must use the operator identity. A parent user and all
 * its subaccounts share userId, so userId alone cannot isolate subaccounts.
 */
export function localRunVisible(state, session = authStatus()) {
  const key = session?.ownerKey || operatorKeyOf(session);
  if (!key || !state) return false;
  if (state.ownerKey) return String(state.ownerKey) === String(key);
  // Legacy runs have no operator identity. Hide them from subaccounts rather
  // than leaking runs created by another subaccount under the same parent.
  if (session.isSubaccount) return false;
  return String(state.ownerUserId || '') === String(session.userId || '');
}

export function localProjectVisible(projectId, metadata, session = authStatus()) {
  const id = String(projectId || '');
  if (!id) return false;
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const key = String(session?.ownerKey || operatorKeyOf(session));
  const tokenProvider = String(session?.tokenProvider || session?.provider || '').toLowerCase();
  if (meta.harnessOwnerKey) return String(meta.harnessOwnerKey) === key;
  // A subaccount-scoped backend token is already filtered by the platform.
  // Without this check, the old local whitelist hides every allowed project
  // that has not been attached yet.
  if (tokenProvider === 'subaccount') return true;
  // Normal users own the projects returned by their own token.
  if (!session?.isSubaccount) return true;
  // A subaccount can only see a project it has already attached locally.
  try {
    for (const file of readdirSync(stateDir())) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      try {
        const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
        if (String(state?.projectId || '') === id && localRunVisible(state, session)) return true;
      } catch {
        /* skip broken state */
      }
    }
  } catch {
    /* state dir missing */
  }
  return false;
}

export function runOwnedBy(state, viewer) {
  if (!state) return null;
  const key = String(viewer?.ownerKey || '');
  if (key && state.ownerKey) return String(state.ownerKey) === key;
  const owner = String(state.ownerUserId || '');
  const uid = String(viewer?.userId || '');
  if (!owner) return null;
  return Boolean(uid) && owner === uid;
}
