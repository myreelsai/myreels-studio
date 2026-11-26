import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShotVideoItemFromParts, buildShotVideoTaskConfig } from '../lib/story/payload.js';

const tool = {
  id: 'tool-v',
  serviceId: 'svc-v',
  slug: 'myreels-vega',
  modelName: 'wand-vega-video-1.0-pro',
  userInputSchema: {
    aspect_ratio: { default: 'adaptive' },
    duration: { default: 5 },
    resolution: { default: '720P' },
    seed: { default: 0 },
    sound: { default: 'on' },
    auto_compliance: { default: true },
  },
};

test('shot video payload: 画幅、时长、模型默认值全部显式传递', () => {
  const item = buildShotVideoItemFromParts(
    { id: 'shot-1' },
    'prompt',
    ['https://img/a.png'],
    { defaultAspect: '9:16', videoSchema: tool.userInputSchema },
    15,
  );
  assert.equal(item.userInput.prompt, 'prompt');
  assert.equal(item.userInput.aspect_ratio, '9:16');
  assert.equal(item.userInput.aspectRatio, undefined);
  assert.equal(item.userInput.duration, 15);
  assert.equal(item.userInput.images[0], 'https://img/a.png');
  assert.equal(item.userInput.resolution, '720P');
  assert.equal(item.userInput.seed, 0);
  assert.equal(item.userInput.sound, 'on');
  assert.equal(item.userInput.auto_compliance, true);
  assert.equal(item.finalParameters.aspect_ratio, '9:16');
  assert.equal(item.finalParameters.duration, 15);
});

test('shot video task config: ratio 与 schema 默认值一致', () => {
  const cfg = {
    defaultAspect: '9:16',
    videoModel: 'MyReels Pro (sd 2.0 4-8折)',
    videoSchema: tool.userInputSchema,
  };
  const body = buildShotVideoTaskConfig(tool, cfg);
  assert.equal(body.taskType, 'video');
  assert.equal(body.userInput.aspect_ratio, '9:16');
  assert.equal(body.userInput.resolution, '720P');
  assert.equal(body.userInput.auto_compliance, true);
  assert.equal(body.finalParameters.aspect_ratio, '9:16');
  assert.equal(body.finalParameters.model, cfg.videoModel);
});

test('shot video payload: 换模型字段名仍能正确映射', () => {
  const otherSchema = {
    ratio: { default: '16:9' },
    duration_seconds: { default: 5 },
    image1: { type: 'image' },
    image2: { type: 'image' },
    seed: { default: 7 },
  };
  const item = buildShotVideoItemFromParts(
    { id: 'shot-2' },
    'prompt-2',
    ['https://img/1.png', 'https://img/2.png'],
    { defaultAspect: '9:16', videoSchema: otherSchema },
    10,
  );
  assert.equal(item.userInput.ratio, '9:16');
  assert.equal(item.userInput.aspect_ratio, undefined);
  assert.equal(item.userInput.duration_seconds, 10);
  assert.equal(item.userInput.image1, 'https://img/1.png');
  assert.equal(item.userInput.image2, 'https://img/2.png');
  assert.equal(item.userInput.seed, 7);
  assert.equal(item.finalParameters.aspect_ratio, '9:16');
});

