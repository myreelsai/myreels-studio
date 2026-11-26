import test from 'node:test';
import assert from 'node:assert/strict';
import { splitShotPrompt } from '../lib/story/split.js';

const prompt = `## 分镜1｜00:00—00:30（30 秒）片场撞人

**出场角色**：沈遥、白灵
**场景**：片场·夜

0.0—10.0秒：沈遥抱着剧本经过。
10.0—20.0秒：白灵撞上沈遥。
20.0—30.0秒：程史走来。`;

test('splitShotPrompt: 30s 拆成两段 15s 并重置时间', () => {
  const out = splitShotPrompt(prompt, 15);
  assert.match(out.first, /00:00—00:15（15 秒）/);
  assert.match(out.second, /承接/);
  assert.match(out.first, /0(?:\.0)?—10秒/);
  assert.match(out.second, /0(?:\.0)?—10秒/);
});

test('splitShotPrompt: 无时间切点时给警告', () => {
  const out = splitShotPrompt('只有文字没有时间码', 15);
  assert.ok(out.warnings.length);
});
