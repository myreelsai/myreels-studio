import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_TEMPLATE_KEYS,
  missingAssetRatios,
  missingAssetTemplates,
  normalizeAssetType,
  recommendRatio,
  styleWikiIdFromMetadata,
  templateKeyFor,
} from '../lib/story/templates.js';

test('资产模板：四类 key 映射稳定', () => {
  assert.equal(templateKeyFor('character'), 'defaultCharacterTemplateSlug');
  assert.equal(templateKeyFor('item'), 'defaultItemTemplateSlug');
  assert.equal(templateKeyFor('object'), 'defaultItemTemplateSlug');
  assert.equal(templateKeyFor('scene'), 'defaultSceneTemplateSlug');
  assert.equal(templateKeyFor('creature'), 'defaultCreatureTemplateSlug');
  assert.equal(templateKeyFor('unknown'), '');
});

test('资产模板：缺失检测覆盖四类', () => {
  assert.deepEqual(
    missingAssetTemplates({}),
    Object.keys(ASSET_TEMPLATE_KEYS)
  );
  assert.deepEqual(
    missingAssetTemplates({
      defaultCharacterTemplateSlug: 'a',
      defaultSceneTemplateSlug: 'b',
      defaultItemTemplateSlug: 'c',
      defaultCreatureTemplateSlug: 'd',
    }),
    []
  );
  assert.deepEqual(
    missingAssetTemplates({ defaultCharacterTemplateSlug: 'a', defaultSceneTemplateSlug: 'b' }),
    ['item', 'creature']
  );
});

test('资产模板：object 归一到 item', () => {
  assert.equal(normalizeAssetType('object'), 'item');
  assert.equal(normalizeAssetType('ITEM'), 'item');
  assert.equal(normalizeAssetType('nope'), '');
});

test('比例推荐：从模板名解析，否则按类型回退', () => {
  assert.equal(recommendRatio('character', '角色人设四视图3:4'), '16:9');
  assert.equal(recommendRatio('character', '16：9故事板'), '16:9');
  assert.equal(recommendRatio('character', '9:16角色设定图（多视图）'), '16:9');
  assert.equal(recommendRatio('scene', '一键生成现有场景的不同角度'), '16:9');
  assert.equal(recommendRatio('item', '道具设定图多视角'), '16:9');
  assert.equal(recommendRatio('creature', '16:9多视图'), '16:9');
});

test('比例推荐：优先按画面格局判断，而非模板名里的数字', () => {
  assert.equal(recommendRatio('character', '角色人设四视图3:4', '角色人设四视图'), '16:9');
  assert.equal(recommendRatio('character', '三视图', '三视图设定板'), '16:9');
  assert.equal(recommendRatio('character', '单人半身像3:4'), '9:16');
  assert.equal(recommendRatio('item', '道具设定图多视角'), '16:9');
  assert.equal(recommendRatio('item', '单件道具'), '1:1');
});

test('比例缺失检测覆盖四类', () => {
  assert.deepEqual(missingAssetRatios({}), ['character', 'scene', 'item', 'creature']);
  assert.deepEqual(
    missingAssetRatios({
      defaultCharacterRatio: '9:16',
      defaultSceneRatio: '16:9',
      defaultItemRatio: '1:1',
      defaultCreatureRatio: '16:9',
    }),
    []
  );
});

test('WebUI 设置为不使用画风时不应用画风', () => {
  assert.equal(styleWikiIdFromMetadata({ defaultStyleIgnored: true, defaultStyleWikiPromptIds: [100] }), 0);
  assert.equal(styleWikiIdFromMetadata({ defaultStyleWikiPromptIds: [100] }), 100);
  assert.equal(styleWikiIdFromMetadata({ defaultStyleWikiPrompt: { pageId: 200 } }), 200);
});
