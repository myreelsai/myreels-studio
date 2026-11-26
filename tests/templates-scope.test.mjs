import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findAssetTemplate,
  isAssetTemplateCandidate,
  mergeAssetTemplates,
  sortAssetTemplates,
  templateIdFromValue,
  templateScopeLabel,
} from '../lib/story/templates.js';

test('模板匹配：数字 ID 和 slug 都能命中', () => {
  const options = [
    { id: 10017307, slug: 'wiki-prompt-team-character', title: '3:4 无头人物角色图', scopes: ['team'] },
    { id: 10002068, slug: 'wiki-prompt-team-item', title: '物品六视角', scopes: ['team'] },
  ];
  assert.equal(findAssetTemplate(options, '10017307')?.slug, 'wiki-prompt-team-character');
  assert.equal(findAssetTemplate(options, 'wiki-prompt-team-item')?.id, 10002068);
  assert.equal(findAssetTemplate(options, 'missing'), null);
});

test('模板合并：按 ID 去重并合并来源标签', () => {
  const merged = mergeAssetTemplates([
    [{ id: 7, slug: 'public-7', title: '公共模板', scopes: ['public'] }],
    [{ id: 7, slug: 'public-7', title: '公共模板', scopes: ['team'] }],
    [{ id: 8, slug: 'mine-8', title: '我的模板', scopes: ['mine'] }],
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].scopes, ['public', 'team']);
  assert.deepEqual(merged[1].scopes, ['mine']);
  assert.equal(templateScopeLabel(merged[0].scopes), '公共/团队');
});

test('模板候选过滤：canvas 阶段或分类不匹配的私有模板不进入资产列表', () => {
  assert.equal(isAssetTemplateCandidate({ metadata: { storyStage: 'canvas' } }, 'character'), false);
  assert.equal(isAssetTemplateCandidate({ metadata: { storyStage: 'canvas', taxonomy_slug: 'character' } }, 'character'), true);
  assert.equal(isAssetTemplateCandidate({ metadata: { storyStage: 'asset', taxonomy_slug: 'character' } }, 'character'), true);
  assert.equal(isAssetTemplateCandidate({ metadata: { storyStage: 'asset', taxonomy_slug: 'scene' } }, 'character'), false);
  assert.equal(isAssetTemplateCandidate({ metadata: {} }, 'character'), true);
});

test('模板列表按名称排序，数字按数值顺序', () => {
  const sorted = sortAssetTemplates([
    { title: '10 号模板', slug: 'a' },
    { title: '2 号模板', slug: 'b' },
    { title: '阿尔法', slug: 'c' },
    { title: 'Beta', slug: 'd' },
  ]);
  assert.deepEqual(sorted.map((item) => item.title), ['2 号模板', '10 号模板', '阿尔法', 'Beta']);
});

test('模板 ID 回退：没有目录命中时仍接受数字模板 ID', () => {
  assert.equal(templateIdFromValue('10017307', null), 10017307);
  assert.equal(templateIdFromValue('10017307', { id: 10017307 }), 10017307);
  assert.equal(templateIdFromValue('wiki-prompt-team-character', null), 0);
});
