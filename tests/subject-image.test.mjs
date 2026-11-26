import test from 'node:test';
import assert from 'node:assert/strict';
import { assetNeedsSubjectImage } from '../lib/story/templates.js';

test('只有角色/场景需要主体图，物品/生物不垫图', () => {
  assert.equal(assetNeedsSubjectImage('character'), true);
  assert.equal(assetNeedsSubjectImage('scene'), true);
  assert.equal(assetNeedsSubjectImage('scene', 'panorama'), false);
  assert.equal(assetNeedsSubjectImage('item'), false);
  assert.equal(assetNeedsSubjectImage('creature'), false);
  assert.equal(assetNeedsSubjectImage('object'), false);
});
