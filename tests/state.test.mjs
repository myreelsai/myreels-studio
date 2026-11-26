import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunState, writeRunState, statePath, migrateState, STATE_VERSION, acquireLock, releaseLock } from '../lib/core/state.js';
import { unlinkSync } from 'node:fs';

const RUN_ID = '__state_test__';

test('writeRunState: 原子写 + schemaVersion', () => {
  const file = writeRunState(RUN_ID, { projectId: 'p1', stage: 'ASSETS_DONE' });
  assert.equal(file, statePath(RUN_ID));
  const state = readRunState(RUN_ID);
  assert.equal(state.schemaVersion, STATE_VERSION);
  assert.equal(state.projectId, 'p1');
  try { unlinkSync(statePath(RUN_ID)); } catch { /* ignore */ }
});

test('readRunState: 不存在返回 null', () => {
  assert.equal(readRunState('__missing_run__'), null);
});

test('migrateState: v0 补版本号', () => {
  const migrated = migrateState({ projectId: 'p1' });
  assert.equal(migrated.schemaVersion, STATE_VERSION);
  assert.equal(migrated.migratedFrom, 0);
});

test('锁：互斥与释放', () => {
  const lock = acquireLock('__lock_test__', { retries: 1, intervalMs: 1 });
  assert.ok(lock);
  const second = acquireLock('__lock_test__', { retries: 1, intervalMs: 1 });
  assert.equal(second, '');
  releaseLock(lock);
  const third = acquireLock('__lock_test__', { retries: 1, intervalMs: 1 });
  assert.ok(third);
  releaseLock(third);
});
