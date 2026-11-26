import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShotCues, scaleCues, buildSrt } from '../lib/story/subtitle.js';

const PROMPT = [
  '【整体设定】画风：电影感写实摄影。',
  '0-3 秒：日，开放办公区，中景。陈屿说道："他们扔了我的工牌。" 蒋川说道："标书呢？"',
  '3-8 秒：日，会议室，中景。郑川说道："项目，你全权负责。"',
  '8-15 秒：日，工位区，陈屿说道："我重打的标书，被动了。"',
].join('\n');

test('parseShotCues: 提取时间与台词', () => {
  const cues = parseShotCues(PROMPT);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 3);
  assert.match(cues[0].text, /他们扔了我的工牌/);
  assert.equal(cues[1].start, 3);
  assert.equal(cues[1].end, 8);
});

test('parseShotCues: 默认只保留台词，旁白块被跳过', () => {
  const cues = parseShotCues('0-3 秒：日，办公区，全景，无人说话。\n3-8 秒：陈屿说道："你好。"');
  assert.equal(cues.length, 1);
  assert.match(cues[0].text, /你好/);
});

test('parseShotCues: 无时间戳时用引号兜底', () => {
  const cues = parseShotCues('某人说道："只有一句台词。"');
  assert.equal(cues.length, 1);
  assert.match(cues[0].text, /只有一句台词/);
});

test('scaleCues: 按视频时长缩放', () => {
  const cues = scaleCues([{ start: 0, end: 10, text: 'a' }], 5, 30);
  assert.ok(Math.abs(cues[0].end - (10 * 5) / 30) < 1e-9);
});

test('buildSrt: 序号与时间格式', () => {
  const srt = buildSrt([{ start: 0, end: 1.5, text: '第一句' }, { start: 2, end: 3, text: '第二句' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\n第一句/m);
  assert.match(srt, /^2\n00:00:02,000 --> 00:00:03,000\n第二句/m);
});
