import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_RULES } from '../lib/rules/builtin.js';
import { loadRules, findRuleForCode } from '../lib/rules/index.js';

test('builtin rules: id 唯一且字段完整', () => {
  const ids = BUILTIN_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of BUILTIN_RULES) {
    if (rule.kind === 'code') assert.ok(rule.check);
    assert.ok(['error', 'warn', 'info'].includes(rule.level));
    assert.ok(['code', 'manual'].includes(rule.kind));
  }
});

test('loadRules: 内置规则按 code/manual 分类', () => {
  const { rules, code, manual } = loadRules();
  assert.equal(rules.length, code.length + manual.length);
  assert.ok(code.some((rule) => rule.id === 'video.prompt.maxLength'));
  assert.ok(manual.some((rule) => rule.id === 'character.identity'));
});

test('findRuleForCode: 代码码映射到规则', () => {
  const { rules } = loadRules();
  assert.equal(findRuleForCode('prompt-too-long', rules)?.id, 'video.prompt.maxLength');
  assert.equal(findRuleForCode('too-many-refs', rules)?.id, 'video.refs.maxFiles');
  assert.equal(findRuleForCode('unknown-code', rules), null);
});
