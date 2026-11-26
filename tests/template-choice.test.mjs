import test from 'node:test';
import assert from 'node:assert/strict';
import { isGroupCharacterAsset, inferTemplateRule } from '../lib/story/templates.js';

test('群体角色自动识别：随行人员/群像/众人', () => {
  assert.equal(isGroupCharacterAsset({ name: '沈家随行人员' }), true);
  assert.equal(isGroupCharacterAsset({ name: '片场群演' }), true);
  assert.equal(isGroupCharacterAsset({ name: '宴会宾客' }), true);
  assert.equal(isGroupCharacterAsset({ name: '沈遥' }), false);
  assert.equal(isGroupCharacterAsset({ name: '白灵', description: '女演员' }), false);
});

test('场景/物品/生物也按描述自动匹配模板规则', () => {
  assert.equal(inferTemplateRule('scene', '场景设定板，多角度展示')?.titlePattern, '场景设定板');
  assert.equal(inferTemplateRule('scene', '动漫场景，二次元风格')?.titlePattern, '动漫场景');
  assert.equal(inferTemplateRule('item', '道具多视角设定图')?.titlePattern, '多视角');
  assert.equal(inferTemplateRule('item', '古风长剑')?.titlePattern, '古风道具');
  assert.equal(inferTemplateRule('creature', '生物三视图设定')?.titlePattern, '多视图');
  assert.equal(inferTemplateRule('scene', '夜晚酒店入口')?.titlePattern, undefined);
});


import { templateKeyFor } from '../lib/story/templates.js';

test('main and variant template keys are separate', () => {
  assert.equal(templateKeyFor('character'), 'defaultCharacterTemplateSlug');
  assert.equal(templateKeyFor('character', true), 'defaultCharacterVariantTemplateSlug');
  assert.equal(templateKeyFor('scene', true), 'defaultSceneVariantTemplateSlug');
  assert.equal(templateKeyFor('item', true), 'defaultItemTemplateSlug');
});

