import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, episodeLayout, layoutOfState } from '../lib/storage/layout.js';

test('slugify: 去掉非法字符并限长', () => {
  assert.equal(slugify('自动流程验证-他们扔了我的工牌'), '自动流程验证-他们扔了我的工牌');
  assert.equal(slugify('a/b:c*d?'), 'a-b-c-d');
  assert.equal(slugify('', 'fallback'), 'fallback');
});

test('episodeLayout: 固定浅层结构', () => {
  const layout = episodeLayout({ projectTitle: '自动流程验证', projectId: 'p1', episodeNo: 4, baseDir: 'E:/runs' });
  assert.ok(layout.projectDir.endsWith('自动流程验证'));
  assert.ok(layout.episodeDir.endsWith('ep04'));
  assert.ok(layout.renderPath.endsWith('ep04.mp4'));
  assert.ok(layout.subtitlePath.endsWith('ep04.srt'));
  assert.ok(layout.shotsDir.endsWith('shots'));
  assert.ok(layout.assetsDir.endsWith('assets'));
});

test('layoutOfState: 无集号时用 runId 短名', () => {
  const layout = layoutOfState({ runId: 'abcdef12-3456', projectId: 'p1' }, 'E:/runs');
  assert.ok(layout.episodeDir.endsWith('abcdef12-345'));
});
