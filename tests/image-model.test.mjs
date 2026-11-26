import test from 'node:test';
import assert from 'node:assert/strict';
import { findImageTool } from '../lib/story/image-model.js';

const tools = [
  { id: 'd2a95e26-b47b-440b-aa78-07d1c35836ad', slug: 'pr-d2a95e26', modelName: '{{model}}', name: 'GPT Image 2 LCC' },
  { id: 'f3dbf7f6-6326-4431-8c98-845c533d1488', slug: 'pr-f3dbf7f6', modelName: 'kling-v3-omni', name: 'Kling O3' },
];

test('WebUI defaultImageModel 优先于插件旧 imageModelSlug', () => {
  const tool = findImageTool(tools, {
    defaultImageModel: 'd2a95e26-b47b-440b-aa78-07d1c35836ad',
    imageModelSlug: 'pr-f3dbf7f6',
  });
  assert.equal(tool?.slug, 'pr-d2a95e26');
});

test('支持按工具 ID、slug、modelName 解析图片模型', () => {
  assert.equal(findImageTool(tools, { defaultImageModel: 'd2a95e26-b47b-440b-aa78-07d1c35836ad' })?.slug, 'pr-d2a95e26');
  assert.equal(findImageTool(tools, { defaultImageModel: 'pr-f3dbf7f6' })?.slug, 'pr-f3dbf7f6');
  assert.equal(findImageTool(tools, { defaultImageModel: 'kling-v3-omni' })?.slug, 'pr-f3dbf7f6');
});

test('显式 imageModelSlug 优先', () => {
  assert.equal(findImageTool(tools, { defaultImageModel: 'd2a95e26-b47b-440b-aa78-07d1c35836ad' }, 'pr-f3dbf7f6')?.slug, 'pr-f3dbf7f6');
});
