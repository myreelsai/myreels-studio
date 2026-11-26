import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_VERSION = 1;

export function stateDir() {
  return join(homedir(), '.dsh', 'storages', 'myreels-studio');
}

export function statePath(runId) {
  return join(stateDir(), `${runId}.json`);
}

export function migrateState(state) {
  if (!state || typeof state !== 'object') return state;
  const version = Number(state.schemaVersion || 0);
  if (version >= STATE_VERSION) return state;
  // v0（无版本号）→ v1：仅补版本号，字段兼容
  return { ...state, schemaVersion: STATE_VERSION, migratedFrom: version };
}

export function readRunState(runId) {
  try {
    const state = JSON.parse(readFileSync(statePath(runId), 'utf8'));
    return state && typeof state === 'object' ? migrateState(state) : null;
  } catch {
    return null;
  }
}

export function acquireLock(runId, { retries = 20, intervalMs = 50 } = {}) {
  mkdirSync(stateDir(), { recursive: true });
  const lock = join(stateDir(), `${runId}.lock`);
  for (let i = 0; i < retries; i += 1) {
    try {
      const fd = openSync(lock, 'wx');
      closeSync(fd);
      return lock;
    } catch {
      const until = Date.now() + intervalMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return '';
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

export function projectSpentPoints(projectId) {
  const id = String(projectId || '');
  if (!id) return 0;
  let total = 0;
  try {
    for (const name of readdirSync(stateDir())) {
      if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
      try {
        const state = JSON.parse(readFileSync(join(stateDir(), name), 'utf8'));
        if (String(state?.projectId || '') === id) total += Number(state.spentPoints || 0);
      } catch {
        /* skip broken */
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export function writeRunState(runId, data) {
  mkdirSync(stateDir(), { recursive: true });
  const lock = acquireLock(runId);
  try {
    const file = statePath(runId);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const payload = { ...data, schemaVersion: STATE_VERSION };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
    return file;
  } finally {
    releaseLock(lock);
  }
}
