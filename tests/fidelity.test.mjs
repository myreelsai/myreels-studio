import test from 'node:test';
import assert from 'node:assert/strict';
import { compareScriptFidelity } from '../lib/story/fidelity.js';

const original = `第1集

【1-1 夜 内 客厅】
人物：林夏、周川
△林夏推门进入。
林夏：你怎么在这里？
周川：门没锁。`;

const good = `第1集

【1-1 夜 内 客厅】
人物：林夏、周川
△林夏推门进入。
林夏（低声）：你怎么在这里？
周川：门没锁。`;

test('compareScriptFidelity: 结构转换不改变剧情时通过', () => {
  const result = compareScriptFidelity(original, good);
  assert.equal(result.ok, true);
  assert.equal(result.scenes.original, 1);
});

test('compareScriptFidelity: 台词改写/场景丢失报错', () => {
  const bad = `第1集

【1-2 夜 内 书房】
人物：林夏
△林夏推门进入。
林夏：你来了？`;
  const result = compareScriptFidelity(original, bad);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'dialogue-missing' || i.code === 'dialogue-changed'));
  assert.ok(result.issues.some((i) => i.code === 'scene-missing'));
  assert.ok(result.issues.some((i) => i.code === 'character-missing'));
});
