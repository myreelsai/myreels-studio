import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFreezeSeconds, buildSubtitleFilter } from '../lib/media/ffmpeg.js';

test('parseFreezeSeconds: 累加多段冻结时长', () => {
  const log = 'freezedetect: freeze_start: 1.2\nfreezedetect: freeze_duration: 2.5\nfreezedetect: freeze_start: 8\nfreezedetect: freeze_duration: 1.5';
  assert.equal(parseFreezeSeconds(log), 4);
  assert.equal(parseFreezeSeconds(''), 0);
});

test('buildSubtitleFilter: Windows 路径转义 + 字号/边距', () => {
  const filter = buildSubtitleFilter('C:\\runs\\ep4.srt', { fontSize: 22, marginV: 100 });
  assert.match(filter, /^subtitles='/);
  assert.ok(filter.includes("C\\:/runs/ep4.srt"));
  assert.match(filter, /force_style='FontSize=22,MarginV=100'/);
});
