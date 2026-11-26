import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScript, validateDirectorScript, validateDirectorDraft, validateNormalScript } from '../lib/story/script-format.js';

const director = `# 第1集

## 分镜1｜00:00—00:10（10 秒）回到家中

**出场角色**：甲
**场景**：客厅·夜
**画面**：甲推门进入。
**运镜**：中景。
**动作与表演**：推门 → 坐下。
**对白/旁白**：无
**声音**：雨声。
**结尾状态**：甲坐下。

## 分镜2｜00:10—00:18（8 秒）电话

**出场角色**：甲
**场景**：客厅·夜
**画面**：甲接电话。
**运镜**：近景。
**动作与表演**：接听 → 站起。
**对白/旁白**：甲：“真的吗？”
**声音**：电话音。
**结尾状态**：甲站直。`;

const normal = `第1集

【1-1 夜 内 客厅】
人物：林夏、周川
△林夏推门进入。
林夏（低声）：你怎么在这里？
周川：门没锁。`;

test('classifyScript: 导演本/普通本', () => {
  assert.equal(classifyScript(director).format, 'director');
  assert.equal(classifyScript(normal).format, 'normal');
  assert.equal(classifyScript('纯文字小说，没有场次').format, 'unknown');
});

test('validateDirectorScript: 时长/字段/连续', () => {
  const result = validateDirectorScript(director, { maxDurationSec: 15 });
  assert.equal(result.ok, true);
  assert.equal(result.blocks, 2);
  const over = validateDirectorScript(director, { maxDurationSec: 8 });
  assert.equal(over.ok, false);
  assert.ok(over.issues.some((i) => i.code === 'over-cap'));
});

test('validateNormalScript: 第一行/分镜/时间码', () => {
  assert.equal(validateNormalScript(normal).ok, true);
  const bad = validateNormalScript('# 第1集\n分镜1｜00:00—00:08（8 秒）\n【1-1】');
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === 'has-storyboard'));
});

test('导演本草稿：分镜+秒级切点可识别并校验', () => {
  const draft = `第1集：测试\n\n分镜1 | 0-30s\n场景：客厅\n出场角色：甲\n0.0—10.0秒：甲进门。\n10.0—20.0秒：甲坐下。\n20.0—30.0秒：甲接电话。`;
  const result = classifyScript(draft);
  assert.equal(result.format, 'director-draft');
  const check = validateDirectorDraft(draft, { maxDurationSec: 30 });
  assert.equal(check.ok, true);
  assert.equal(check.blocks, 1);
  const over = validateDirectorDraft(draft, { maxDurationSec: 20 });
  assert.equal(over.ok, false);
});
