import test from 'node:test';
import assert from 'node:assert/strict';
import { auditAssetPrompts } from '../lib/story/asset-audit.js';

test('asset audit exposes full prompts and only blocks structural gaps', () => {
  const assets = [
    { id: 'a1', name: '沈遥', assetType: 'character', description: '现代都市女性，黑色长发，米色风衣' },
  ];
  const variants = new Map([
    ['a1', [{ id: 'v1', name: '日常造型', prompt: '沈遥，黑色长发，米色风衣，站在便利店门口', imageUrl: 'https://x/1.png' }]],
  ]);
  const result = auditAssetPrompts({ assets, variantsByAsset: variants, shots: [] });
  assert.equal(result.ok, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.items[0].prompt, '沈遥，黑色长发，米色风衣，站在便利店门口');
  assert.equal(result.items[0].imageUrl, 'https://x/1.png');
});

test('asset audit blocks empty prompt/description and no variants', () => {
  const assets = [
    { id: 'a1', name: '空资产', assetType: 'character', description: '' },
    { id: 'a2', name: '无变体', assetType: 'scene', description: '夜晚街道' },
  ];
  const variants = new Map([
    ['a1', [{ id: 'v1', name: '默认', prompt: '' }]],
    ['a2', []],
  ]);
  const result = auditAssetPrompts({ assets, variantsByAsset: variants, shots: [] });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((message) => message.includes('描述为空')));
  assert.ok(result.blockers.some((message) => message.includes('提示词和描述都为空')));
  assert.ok(result.blockers.some((message) => message.includes('没有变体')));
});
