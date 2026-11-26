import test from 'node:test';
import assert from 'node:assert/strict';
import { compileShotPrompt, buildVariantGenerateBody } from '../lib/story/prompt.js';

test('compileShotPrompt: 同名复用、按出现顺序编号', () => {
  const refMap = new Map([
    ['甲方代表', 'https://img/a.png'],
    ['陈屿', 'https://img/b.png'],
  ]);
  const shot = '【设定】\n- 角色：(@深色衬衫 | 甲方代表) 为 甲方代表\n- 角色：(@浅灰衬衫 | 陈屿) 为 陈屿\n- 场景：( @办公室 | 会议室 ) 为 会议室';
  const { prompt, images } = compileShotPrompt(shot, refMap);
  assert.equal(images.length, 2);
  assert.equal(images[0], 'https://img/a.png');
  assert.equal(images[1], 'https://img/b.png');
  assert.match(prompt, /【<<<image1>>>】 为 甲方代表/);
  assert.match(prompt, /【<<<image2>>>】 为 陈屿/);
  assert.match(prompt, /会议室/);
  assert.doesNotMatch(prompt, /\(@/);
});

test('compileShotPrompt: 没有参考图时保留纯文本', () => {
  const { prompt, images } = compileShotPrompt('- 角色：(@造型 | 某人) 为 某人', new Map());
  assert.equal(images.length, 0);
  assert.match(prompt, /某人/);
  assert.doesNotMatch(prompt, /<<<image/);
});

test('buildVariantGenerateBody: 载荷契约（T30）', () => {
  const body = buildVariantGenerateBody(
    { id: 'tool-1', serviceId: 'svc-1', modelName: 'gpt-image-2-bravo' },
    { aspect: '9:16', assetType: 'character' },
  );
  assert.equal(body.serviceId, 'svc-1');
  assert.equal(body.promptResourceId, 'tool-1');
  assert.equal(body.generationTaskConfig.taskType, 'image');
  assert.equal(body.generationTaskConfig.userInput.aspect_ratio, '9:16');
  assert.equal(body.generationTaskConfig.finalParameters.assetType, 'character');
  assert.equal(body.generationTaskConfig.finalParameters.model, 'gpt-image-2-bravo');
});

test('buildVariantGenerateBody: 选中模板写入 prompt2WikiIds', () => {
  const body = buildVariantGenerateBody(
    { id: 'tool-1', serviceId: 'svc-1', modelName: 'gpt-image-2-bravo' },
    { aspect: '9:16', assetType: 'character', templateId: 10001375 },
  );
  assert.deepEqual(body.generationTaskConfig.userInput.prompt2WikiIds, [10001375]);
});

test('buildVariantGenerateBody: 项目画风写入 prompt1WikiIds', () => {
  const body = buildVariantGenerateBody(
    { id: 'tool-1', serviceId: 'svc-1', modelName: 'gpt-image-2-bravo' },
    { aspect: '3:4', assetType: 'character', templateId: 10001375, styleWikiId: 10001002 },
  );
  assert.deepEqual(body.generationTaskConfig.userInput.prompt1WikiIds, [10001002]);
  assert.deepEqual(body.generationTaskConfig.userInput.prompt2WikiIds, [10001375]);
});

test('buildVariantGenerateBody: 变体携带主体图垫图', () => {
  const body = buildVariantGenerateBody(
    { id: 'tool-1', serviceId: 'svc-1', modelName: 'gpt-image-2-bravo' },
    { aspect: '3:4', assetType: 'character', templateId: 10001375, styleWikiId: 10001002, referenceImage: 'https://example.com/main.png' },
  );
  assert.deepEqual(body.generationTaskConfig.userInput.images, ['https://example.com/main.png']);
});
