import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadRules, saveUserRule, rulesFilePath } from '../rules/index.js';
import { compactNulls } from '../core/util.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_rules',
    description: '生成规则知识库（内置 + 用户 rules.json）：list 查看代码检查规则与 Agent 视觉检查项；add 追加/覆盖一条用户规则（不改代码）。',
    parameters: {
      action: { type: 'string', description: 'list / add（默认 list）' },
      id: { type: 'string', description: 'add 时必填，规则 id（如 video.prompt.maxLength）' },
      scope: { type: 'string', description: 'shot / variant / run' },
      kind: { type: 'string', description: 'code / manual' },
      level: { type: 'string', description: 'error / warn / info' },
      message: { type: 'string', description: '规则说明' },
      check: { type: 'string', description: 'code 规则对应的检查名（如 promptMaxLength）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          total: { type: 'number' },
          code: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                level: { type: 'string' },
                scope: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          manual: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                level: { type: 'string' },
                scope: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`rules: ${value.total} 条（code ${value.code.length} / manual ${value.manual.length}）`];
        lines.push(`- 用户规则文件: ${value.path}`);
        for (const rule of value.code) lines.push(`  · [${rule.level}] ${rule.id} — ${rule.message}`);
        for (const rule of value.manual) lines.push(`  · [manual] ${rule.id} — ${rule.message}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const blockers = [];
      const action = String(args?.action || 'list');
      if (action === 'add') {
        try {
          const rule = {
            id: String(args?.id || ''),
            scope: String(args?.scope || 'shot'),
            kind: String(args?.kind || 'code'),
            level: String(args?.level || 'warn'),
            message: String(args?.message || ''),
            check: String(args?.check || args?.id || ''),
            source: 'user',
          };
          saveUserRule(rule);
        } catch (error) {
          blockers.push(String(error?.message || error));
        }
      } else if (action !== 'list') {
        blockers.push(`未知 action：${action}`);
      }
      const { rules, code, manual } = loadRules();
      const slim = (rule) => ({ id: rule.id, level: rule.level, scope: rule.scope, message: rule.message });
      return compactNulls({
        ok: blockers.length === 0,
        path: rulesFilePath(),
        total: rules.length,
        code: code.map(slim),
        manual: manual.map(slim),
        blockers,
      });
    },
  });
}
