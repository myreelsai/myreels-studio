import test from 'node:test';
import assert from 'node:assert/strict';
import { splitEpisodes } from '../lib/story/script.js';

test('splitEpisodes: 中文集号分段', () => {
  const parts = splitEpisodes('第一集 开端\n内容A\n第二集 冲突\n内容B\n第三集\n内容C');
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.episodeNo), [1, 2, 3]);
  assert.equal(parts[1].title, '冲突');
  assert.equal(parts[1].script, '内容B');
});

test('splitEpisodes: EP 标记与无标记', () => {
  const parts = splitEpisodes('EP01 第一幕\n台词\nEP02\n台词2');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].episodeNo, 1);
  const single = splitEpisodes('没有标记的整段剧本');
  assert.equal(single.length, 1);
  assert.equal(single[0].episodeNo, 1);
});
