import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetGuard, shouldAutoConfirm, nextAction, retryTargets, qcDurationOk, pickDuration, chooseVideoSlug } from '../lib/decisions.js';

test('pickDuration: 按目标选模型支持的最大档位', () => {
  const options = [5, 6, 8, 10, 12, 15];
  assert.equal(pickDuration(10, options), 10);
  assert.equal(pickDuration(15, options), 15);
  assert.equal(pickDuration(20, options), 15);
  assert.equal(pickDuration(3, options), 5);
  assert.equal(pickDuration(30, options), 15);
  assert.equal(pickDuration(20, options, 12), 12);
  assert.equal(pickDuration(8, []), 8);
});

test('budgetGuard: 无预算放行', () => {
  assert.equal(budgetGuard({ budget: 0, spent: 999, nextCost: 100 }).allow, true);
});

test('budgetGuard: 超预算拦截', () => {
  const r = budgetGuard({ budget: 1000, spent: 900, nextCost: 200 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /预算不足/);
});

test('budgetGuard: 刚好够用', () => {
  assert.equal(budgetGuard({ budget: 1000, spent: 800, nextCost: 200 }).allow, true);
});

test('shouldAutoConfirm', () => {
  assert.equal(shouldAutoConfirm('auto'), true);
  assert.equal(shouldAutoConfirm('manual'), false);
  assert.equal(shouldAutoConfirm('off'), false);
});

test('nextAction 顺序', () => {
  assert.equal(nextAction({ analysisStatus: 'processing' }), 'wait-analysis');
  assert.equal(nextAction({ analysisStatus: 'failed' }), 'analysis-failed');
  assert.equal(nextAction({ analysisStatus: 'completed', assetsWithImage: 1, assetsTotal: 9 }), 'generate-assets');
  assert.equal(nextAction({ analysisStatus: 'completed', assetsWithImage: 9, assetsTotal: 9, videoCount: 1, shotsTotal: 2 }), 'generate-shots');
  assert.equal(nextAction({ analysisStatus: 'completed', assetsWithImage: 9, assetsTotal: 9, videoCount: 2, shotsTotal: 2 }), 'render');
});

test('retryTargets 只挑可重试的失败项并自增', () => {
  const out = retryTargets([
    { id: 'a', status: 'failed', retries: 0 },
    { id: 'b', status: 'failed', retries: 1 },
    { id: 'c', status: 'completed', retries: 0 },
  ], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].retries, 1);
});

test('qcDurationOk 边界', () => {
  assert.equal(qcDurationOk(3), true);
  assert.equal(qcDurationOk(0.5), false);
  assert.equal(qcDurationOk(31), false);
  assert.equal(qcDurationOk(NaN), false);
});

 test('chooseVideoSlug: 超过阈值走长视频模型', () => {
   assert.equal(chooseVideoSlug({ targetSec: 10, defaultSlug: 'a', longSlug: 'b' }), 'a');
   assert.equal(chooseVideoSlug({ targetSec: 30, defaultSlug: 'a', longSlug: 'b' }), 'b');
   assert.equal(chooseVideoSlug({ targetSec: 15, defaultSlug: 'a', longSlug: 'b' }), 'a');
 });
