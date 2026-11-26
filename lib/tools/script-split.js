import { readFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactNulls } from '../core/util.js';
import { splitEpisodes } from '../story/script.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_script_split',
    description: '把整部剧本按「第X集 / EPn」拆成分集（只读、免费）：返回每集集号/标题/字数/预览，交给 episode_add 逐集建。',
    parameters: {
      script: { type: 'string', description: '整部剧本全文（与 scriptPath 二选一）' },
      scriptPath: { type: 'string', description: '剧本文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          episodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                episodeNo: { type: 'number' },
                title: { type: 'string' },
                chars: { type: 'number' },
                preview: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`script_split: ${value.count} 集`];
        for (const ep of value.episodes) {
          lines.push(`  · 第 ${ep.episodeNo} 集 ${ep.title || ''}（${ep.chars} 字）${ep.preview ? ` — ${ep.preview}` : ''}`);
        }
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      let text = String(args?.script || '');
      const blockers = [];
      if (!text && args?.scriptPath) {
        try {
          text = readFileSync(String(args.scriptPath), 'utf8');
        } catch (error) {
          blockers.push(`读剧本失败：${String(error?.message || error)}`);
        }
      }
      if (!text.trim()) blockers.push('缺少剧本（script 或 scriptPath）');
      const parts = splitEpisodes(text);
      return compactNulls({
        ok: blockers.length === 0 && parts.length > 0,
        count: parts.length,
        episodes: parts.map((part) => ({
          episodeNo: part.episodeNo,
          title: part.title,
          chars: part.chars,
          preview: part.preview,
        })),
        blockers,
      });
    },
  });
}
