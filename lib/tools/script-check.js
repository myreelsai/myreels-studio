import { readFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactNulls } from '../core/util.js';
import { classifyScript, validateDirectorScript, validateDirectorDraft, validateNormalScript } from '../story/script-format.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_script_check',
    description: '剧本格式检查（免费）：classify 判断导演本/普通本并给分析模式；validate 按 MyReels 规则校验分镜时长/字段/编号或普通本场次/台词格式。',
    parameters: {
      action: { type: 'string', description: 'classify / validate（默认 classify）' },
      script: { type: 'string', description: '剧本全文（与 scriptPath 二选一）' },
      scriptPath: { type: 'string', description: '剧本文件路径' },
      format: { type: 'string', description: 'validate 用：director / normal（可空=自动判断）' },
      maxDurationSec: { type: 'number', description: '导演本单分镜时长上限（15 或 30，默认 30；按原始分镜长度，不默认拆段）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          format: { type: 'string' },
          confidence: { type: 'number' },
          recommendedMode: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              directorBlocks: { type: 'number' },
              timecodes: { type: 'number' },
              fields: { type: 'number' },
              sceneHeaders: { type: 'number' },
              personLines: { type: 'number' },
              actionLines: { type: 'number' },
              dialogueLines: { type: 'number' },
              chars: { type: 'number' },
            },
          },
          mode: { type: 'string' },
          cap: { type: 'number' },
          blocks: { type: 'number' },
          scenes: { type: 'number' },
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
        const lines = [];
        if (value.action === 'classify') {
          const label = { director: '导演本', normal: '普通本', hybrid: '混合/未完成', unknown: '无法判断' }[value.format] || value.format;
          lines.push(`script_check classify: ${label}（置信 ${Math.round((value.confidence || 0) * 100)}%）`);
          lines.push(`- 建议分析模式: ${value.recommendedMode}`);
          for (const item of value.evidence) lines.push(`  · ${item}`);
        } else {
          lines.push(`script_check validate: ${value.ok ? '通过' : '有问题'}（${value.mode}，${value.blocks || value.scenes || 0} 个单元）`);
          for (const issue of value.issues || []) lines.push(`  · [${issue.level}] ${issue.message}`);
        }
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const blockers = [];
      let text = String(args?.script || '');
      if (!text && args?.scriptPath) {
        try {
          text = readFileSync(String(args.scriptPath), 'utf8');
        } catch (error) {
          blockers.push(`读剧本失败：${String(error?.message || error)}`);
        }
      }
      if (!text.trim()) blockers.push('缺少剧本（script 或 scriptPath）');
      const action = String(args?.action || 'classify');
      const classification = text.trim() ? classifyScript(text) : null;
      if (action === 'classify') {
        return compactNulls({
          ok: blockers.length === 0 && Boolean(classification),
          action,
          format: classification?.format,
          confidence: classification?.confidence,
          recommendedMode: classification?.recommendedMode,
          evidence: classification?.evidence || [],
          stats: classification?.stats,
          blockers,
        });
      }
      if (action === 'validate') {
        const format = String(args?.format || classification?.format || '');
        const cap = Number(args?.maxDurationSec || 30);
        const result =
          format === 'director'
            ? validateDirectorScript(text, { maxDurationSec: cap })
            : format === 'director-draft'
              ? validateDirectorDraft(text, { maxDurationSec: cap })
              : format === 'normal'
                ? validateNormalScript(text)
                : null;
        if (!result) blockers.push(`无法按 ${format || '未知'} 格式校验；请传 format=director/normal`);
        const payload = {
          ok: Boolean(result) && result.ok && blockers.length === 0,
          action,
          format,
          mode: result?.mode || '',
          issues: result?.issues || [],
          blockers,
        };
        if (result?.mode === 'director' || result?.mode === 'director-draft') {
          payload.cap = result.cap;
          payload.blocks = result.blocks;
        }
        if (result?.mode === 'normal') payload.scenes = result.scenes;
        return compactNulls(payload);
      }
      blockers.push(`未知 action：${action}`);
      return compactNulls({ ok: false, action, blockers });
    },
  });
}
