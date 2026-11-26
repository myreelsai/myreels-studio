import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILTIN_RULES } from './builtin.js';

export function rulesFilePath() {
  return join(homedir(), '.dsh', 'storages', 'myreels-studio', 'rules.json');
}

function validRule(rule) {
  return rule && typeof rule.id === 'string' && typeof rule.check === 'string' && ['code', 'manual'].includes(rule.kind);
}

export function loadRules() {
  const merged = new Map();
  for (const rule of BUILTIN_RULES) merged.set(rule.id, rule);
  try {
    const user = JSON.parse(readFileSync(rulesFilePath(), 'utf8'));
    if (Array.isArray(user)) {
      for (const rule of user) if (validRule(rule)) merged.set(rule.id, rule);
    }
  } catch {
    /* 没有用户规则 */
  }
  const rules = [...merged.values()];
  return {
    rules,
    code: rules.filter((rule) => rule.kind === 'code'),
    manual: rules.filter((rule) => rule.kind === 'manual'),
  };
}

export function findRuleForCode(code, rules) {
  const list = rules || loadRules().rules;
  const mapping = {
    missing: 'ref.tag.missing',
    'variant-no-image': 'ref.variant.noImage',
    'asset-no-image': 'ref.variant.noImage',
    'asset-fallback': 'ref.asset.fallback',
    'needs-segments': 'shot.duration.cap',
    'too-many-refs': 'video.refs.maxFiles',
    'prompt-too-long': 'video.prompt.maxLength',
    'beats-dense': 'shot.beats.density',
    'refs-too-many': 'shot.refs.recommended',
    'prop-no-blocking': 'shot.prop.blocking',
    'action-not-decomposed': 'shot.action.decompose',
    'subtitle-unlocked': 'shot.subtitle.policy',
    'dialogue-text-risk': 'shot.subtitle.policy',
    'no-continuity-lock': 'shot.continuity.lock',
    'glasses-risk': 'shot.continuity.lock',
    'no-negative-constraints': 'shot.continuity.lock',
    'no-prompt': 'variant.prompt.missing',
    'no-image': 'variant.image.missing',
    'name-missing': 'variant.name.missing',
    'model-missing': 'model.exists',
    'budget-exhausted': 'budget.exhausted',
  };
  const id = mapping[code];
  return id ? list.find((rule) => rule.id === id) || null : null;
}

export function saveUserRule(rule) {
  if (!validRule(rule)) throw new Error('规则需要 id/check/kind');
  const file = rulesFilePath();
  let current = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) current = parsed;
  } catch {
    /* new file */
  }
  const next = current.filter((item) => item.id !== rule.id).concat(rule);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}
