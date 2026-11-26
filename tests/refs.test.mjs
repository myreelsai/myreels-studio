import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRefTags, buildRefIndex, resolveRefTags, compileShotRefs, similarity, findClosestVariant } from '../lib/story/refs.js';

const assets = [
  { id: 'a-char', name: '甲方代表', assetType: 'character' },
  { id: 'a-item', name: '物品', assetType: 'item' },
  { id: 'a-scene', name: '大会议室', assetType: 'scene' },
];
const variants = new Map([
  ['a-char', [{ id: 'v1', name: '深色衬衫商务造型', imageUrl: 'https://img/char.png' }]],
  ['a-item', [
    { id: 'v2', name: '项目章', imageUrl: 'https://img/seal.png' },
    { id: 'v3', name: '标书', imageUrl: '' },
  ]],
  ['a-scene', [{ id: 'v4', name: '大会议室·日间默认视角', imageUrl: '' }, { id: 'v5', name: '大会议室·夜间默认视角', imageUrl: 'https://img/night.png' }]],
]);
const index = buildRefIndex(assets, variants);

test('parseRefTags: 解析变体与资产名', () => {
  const tags = parseRefTags('(@深色衬衫商务造型 | 甲方代表) 与 (@标书 | 物品)');
  assert.equal(tags.length, 2);
  assert.equal(tags[0].variant, '深色衬衫商务造型');
  assert.equal(tags[0].asset, '甲方代表');
});

test('resolveRefTags: 变体有图=ok，变体缺图=variant-no-image', () => {
  const resolved = resolveRefTags('(@标书 | 物品)', index);
  assert.equal(resolved[0].status, 'variant-no-image');
  assert.equal(resolved[0].assetName, '物品');
});

test('compileShotRefs: 缺图变体不会被同资产其它图顶替', () => {
  const out = compileShotRefs('(@标书 | 物品) 和 (@项目章 | 物品)', index);
  assert.equal(out.images.length, 1);
  assert.match(out.images[0], /seal/);
  assert.match(out.prompt, /物品 和 【<<<image1>>>】/);
  assert.ok(out.issues.some((i) => i.status === 'variant-no-image'));
});

test('compileShotRefs: 资产不存在记为 missing', () => {
  const out = compileShotRefs('(@不存在 | 不存在)', index);
  assert.equal(out.issues[0].status, 'missing');
  assert.equal(out.images.length, 0);
});

test('similarity/findClosestVariant: 近似变体名可提示修正', () => {
  assert.ok(similarity('标书底稿', '标书') > 0.4);
  const closest = findClosestVariant('标书底稿', index);
  assert.equal(closest.variantName, '标书');
  assert.equal(closest.assetName, '物品');
});
