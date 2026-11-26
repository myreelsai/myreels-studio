import test from 'node:test';
import assert from 'node:assert/strict';
import { findVideoTool, videoToolOptionValue } from '../lib/story/video-model.js';

const tools = [
  { slug: 'kling-4-0-flash', modelName: 'kling-4-0-flash' },
  { slug: 'pr-cf981766', modelName: '{{model}}', name: 'MyReels H3', userInputSchema: { model: { default: 'MiniMax-H3-FL2VA-MyReels' } } },
];

test('WebUI defaultMultiVideoModel 优先于插件旧 videoModelSlug', () => {
  const tool = findVideoTool(tools, {
    defaultMultiVideoModel: 'kling-4-0-flash',
    videoModelSlug: 'pr-cf981766',
  });
  assert.equal(tool?.slug, 'kling-4-0-flash');
});

test('支持按 slug、modelName 和模型路由解析', () => {
  assert.equal(findVideoTool(tools, { defaultMultiVideoModel: 'pr-cf981766' })?.slug, 'pr-cf981766');
  assert.equal(findVideoTool(tools, { defaultMultiVideoModel: 'kling-4-0-flash' })?.slug, 'kling-4-0-flash');
  assert.equal(findVideoTool(tools, { defaultMultiVideoModel: 'MiniMax-H3-FL2VA-MyReels' })?.slug, 'pr-cf981766');
});

test('显式 videoModelSlug 优先', () => {
  assert.equal(findVideoTool(tools, { defaultMultiVideoModel: 'kling-4-0-flash' }, 'pr-cf981766')?.slug, 'pr-cf981766');
});

test('WebUI 选项值规则：modelName 优先，占位符回退 slug', () => {
  assert.equal(videoToolOptionValue(tools[0]), 'kling-4-0-flash');
  assert.equal(videoToolOptionValue(tools[1]), 'pr-cf981766');
});
