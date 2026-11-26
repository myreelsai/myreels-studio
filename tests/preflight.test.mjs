import test from 'node:test';
import assert from 'node:assert/strict';
import { shotPreflight, variantPreflight, summarizePreflight } from '../lib/story/preflight.js';
import { buildRefIndex } from '../lib/story/refs.js';

const assets = [{ id: 'a1', name: '高蕾', assetType: 'character' }];
const variants = new Map([['a1', [{ id: 'v1', name: '深色西装套装造型', imageUrl: 'https://img/x.png' }]]]);
const index = buildRefIndex(assets, variants);
const videoSchema = {
  prompt: { maxLength: 1000 },
  images: { maxFiles: 9 },
  duration: { options: [{ value: 5 }, { value: 15 }] },
};

test('shotPreflight: 正常分镜 ready', () => {
  const result = shotPreflight({ shotNo: 1, prompt: '(@深色西装套装造型 | 高蕾)', durationSeconds: 10 }, index, videoSchema);
  assert.equal(result.refs, 1);
  assert.equal(summarizePreflight([result]).ready, true);
});

test('shotPreflight: 提示词超长/缺参考图/需分段', () => {
  const longPrompt = `(@不存在的变体 | 不存在的资产) ${'x'.repeat(1200)}`;
  const result = shotPreflight({ shotNo: 2, prompt: longPrompt, durationSeconds: 30 }, index, videoSchema);
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes('ref-missing'));
  assert.ok(codes.includes('prompt-too-long'));
  assert.ok(codes.includes('needs-segments'));
  assert.equal(summarizePreflight([result]).ready, false);
});

test('variantPreflight: 缺文本/缺图/服装变体不校验名字', () => {
  const result = variantPreflight({ name: '高蕾' }, { name: '造型', description: '', variantType: 'costume' }, {});
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes('no-prompt'));
  assert.ok(codes.includes('no-image'));
  assert.ok(!codes.includes('name-missing'));
});
