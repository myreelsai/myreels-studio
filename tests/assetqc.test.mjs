import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectVariant, hasBlockingIssues } from '../lib/story/assetqc.js';

const asset = { name: '高蕾', aliasNames: ['高蕾姐'] };
const good = {
  imageUrl: 'https://img/x.png',
  prompt: `[高蕾]\n【年龄】28岁\n【发型】齐肩短发，黑色，微卷内扣\n【服装】藏青色西装套装，白色丝质衬衫\n【气质】干练冷静`,
  metadata: { confirmed: true },
};

test('inspectVariant: 完整变体无 error', () => {
  const issues = inspectVariant(asset, good);
  assert.equal(hasBlockingIssues(issues), false);
});

test('inspectVariant: 缺图/缺 prompt 为 error', () => {
  const issues = inspectVariant(asset, { prompt: '', metadata: {} });
  assert.ok(issues.some((i) => i.code === 'no-image' && i.level === 'error'));
  assert.ok(issues.some((i) => i.code === 'no-prompt' && i.level === 'error'));
});

test('inspectVariant: prompt 未含资产名提示 warn', () => {
  const issues = inspectVariant(asset, { imageUrl: 'x', prompt: '一位职场女性，短发', metadata: { confirmed: true } });
  assert.ok(issues.some((i) => i.code === 'name-missing' && i.level === 'warn'));
});

test('inspectVariant: prompt 为空时用 description 兜底', () => {
  const issues = inspectVariant(asset, { imageUrl: 'x', prompt: '', description: `[高蕾] ${'齐肩短发，深蓝西装，白衬衫，通勤妆'.repeat(4)}`, metadata: { confirmed: true } });
  assert.equal(issues.some((i) => i.code === 'no-prompt'), false);
});

test('inspectVariant: 未确认为 info 不阻塞', () => {
  const issues = inspectVariant(asset, { ...good, metadata: {} });
  assert.ok(issues.some((i) => i.code === 'unconfirmed'));
  assert.equal(hasBlockingIssues(issues), false);
});
