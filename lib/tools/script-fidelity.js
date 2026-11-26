import { readFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactNulls } from '../core/util.js';
import { compareScriptFidelity } from '../story/fidelity.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_script_fidelity',
    description: '优化前后剧情保真检查（免费）：对比原剧本与优化稿，检查台词是否增删改写、场景是否丢失/换序、人物是否增删、动作是否被改写。',
    parameters: {
      original: { type: 'string', description: '原剧本全文（与 originalPath 二选一）' },
      originalPath: { type: 'string', description: '原剧本文件路径' },
      optimized: { type: 'string', description: '优化后剧本全文（与 optimizedPath 二选一）' },
      optimizedPath: { type: 'string', description: '优化后剧本文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          scenes: {
            type: 'object',
            additionalProperties: false,
            properties: { original: { type: 'number' }, optimized: { type: 'number' } },
          },
          characters: {
            type: 'object',
            additionalProperties: false,
            properties: { original: { type: 'number' }, optimized: { type: 'number' } },
          },
          dialogues: {
            type: 'object',
            additionalProperties: false,
            properties: { original: { type: 'number' }, optimized: { type: 'number' } },
          },
          missingActions: { type: 'number' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string' },
                level: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`script_fidelity: ${value.ok ? '剧情未变' : '发现剧情改动'}（场景 ${value.scenes.original}/${value.scenes.optimized}，人物 ${value.characters.original}/${value.characters.optimized}，台词 ${value.dialogues.original}/${value.dialogues.optimized}）`];
        for (const issue of value.issues || []) lines.push(`  · [${issue.level}] ${issue.message}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const blockers = [];
      const read = (inline, path, label) => {
        if (inline) return String(inline);
        if (!path) {
          blockers.push(`缺少${label}`);
          return '';
        }
        try {
          return readFileSync(String(path), 'utf8');
        } catch (error) {
          blockers.push(`读${label}失败：${String(error?.message || error)}`);
          return '';
        }
      };
      const original = read(args?.original, args?.originalPath, '原剧本');
      const optimized = read(args?.optimized, args?.optimizedPath, '优化稿');
      const result = original && optimized ? compareScriptFidelity(original, optimized) : { ok: false, issues: [], scenes: { original: 0, optimized: 0 }, characters: { original: 0, optimized: 0 }, dialogues: { original: 0, optimized: 0 }, missingActions: 0 };
      return compactNulls({
        ok: result.ok && blockers.length === 0,
        scenes: result.scenes,
        characters: result.characters,
        dialogues: result.dialogues,
        missingActions: result.missingActions,
        issues: result.issues,
        blockers,
      });
    },
  });
}
