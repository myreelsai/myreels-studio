import test from 'node:test';
import assert from 'node:assert/strict';
import { modelOptions, modelOptionsFromTools, matchCatalog } from '../lib/story/models.js';

const models = [
  { modelName: 'seedance', name: 'Seedance', estimatedCost: 289, tags: ['t2v', 'i2v'], isActive: true },
  { modelName: 'nano2', name: 'Nano2', estimatedCost: 23, tags: ['t2i', 'i2i'], isActive: true },
  { modelName: 'seed-audio', name: 'Audio', estimatedCost: 130, tags: ['t2a'], isActive: true },
];
const tools = [
  { modelName: 'seedance', slug: 'pr-seedance', tags: ['t2v', 'i2v'], userInputSchema: { duration: { options: [{ value: 5 }, { value: 15 }] } } },
  { modelName: 'nano2', slug: 'pr-nano2', tags: ['t2i', 'i2i'] },
  { modelName: 'fun-asr', slug: 'pr-asr', tags: ['a2t'] },
  { modelName: 'workflow', slug: 'workflow-x', tags: ['i2v'] },
  { modelName: '{{model}}', slug: 'pr-template', tags: ['t2i'] },
];

test('modelOptions: 按 tag 分类并标记两库交集', () => {
  const video = modelOptions(models, tools, 'video');
  assert.equal(video.list.length, 1);
  assert.equal(video.list[0].modelName, 'seedance');
  assert.equal(video.list[0].inBoth, true);
  assert.equal(video.list[0].maxDuration, 15);
  assert.ok(video.onlyTools.includes('fun-asr'));

  const image = modelOptions(models, tools, 'image');
  assert.equal(image.list.length, 1);
  assert.equal(image.list[0].modelName, 'nano2');
});

test('modelOptionsFromTools: 故事台通道直接用工具目录', () => {
  const video = modelOptionsFromTools(tools, 'video');
  assert.equal(video.list.length, 2);
  assert.ok(video.list.some((item) => item.slug === 'pr-seedance'));
  assert.ok(video.list.some((item) => item.slug === 'workflow-x'));
  assert.equal(video.onlyTools.length, 0);
  const image = modelOptionsFromTools(tools, 'image');
  assert.equal(image.list[0].modelName, 'nano2');
});

test('matchCatalog: 目录与工具目录一致性', () => {
  const hit = matchCatalog({ models, tools, imageModel: 'nano2', videoModelSlug: 'pr-seedance' });
  assert.equal(hit.imageInCatalog, true);
  assert.equal(hit.imageInTools, true);
  assert.equal(hit.videoInCatalog, true);
  assert.equal(hit.videoInTools, true);

  const miss = matchCatalog({ models, tools, imageModel: 'nope', videoModelSlug: 'pr-asr' });
  assert.equal(miss.imageInCatalog, false);
  assert.equal(miss.videoInCatalog, false);
});
