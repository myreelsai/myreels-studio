import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { stateDir } from '../core/state.js';
import { summarizeRun, groupRunsByProject } from '../story/portfolio.js';
import { authStatus, credentialsOf, loginToken } from '../core/auth.js';
import { localRunVisible } from '../core/owner.js';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { filterRunsByBackendProject } from '../core/project-visibility.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_runs',
    description: '列出本机所有 run（按剧分组，只读、免费）：runId/集/stage/花费/预算/是否出片/目录；一部剧多集用 projectId 聚合，支持单会话管多部。',
    parameters: {
      projectId: { type: 'string', description: '只看某部剧（可空=全部）' },
      limit: { type: 'number', description: '最多返回多少集（默认 100）' },
      includeDeleted: { type: 'boolean', description: '包含 WebUI 已删除或当前不可访问的项目 run（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          totalRuns: { type: 'number' },
          spent: { type: 'number' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                projectId: { type: 'string' },
                projectTitle: { type: 'string' },
                spent: { type: 'number' },
                budget: { type: 'number' },
                latestUpdatedAt: { type: 'string' },
                runs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      runId: { type: 'string' },
                      projectId: { type: 'string' },
                      projectTitle: { type: 'string' },
                      episodeNo: { type: 'number' },
                      stage: { type: 'string' },
                      spent: { type: 'number' },
                      budget: { type: 'number' },
                      rendered: { type: 'boolean' },
                      updatedAt: { type: 'string' },
                      episodeDir: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`runs: ${value.totalRuns} 集 / 共花 ${value.spent} 点`];
        for (const group of value.groups) {
          lines.push(`- ${group.projectTitle}（${group.projectId.slice(0, 8)}）花费 ${group.spent}/${group.budget}`);
          for (const run of group.runs) {
            lines.push(`    ${run.runId.slice(0, 8)} | EP${run.episodeNo || '?'} | ${run.stage || '?'} | ${run.spent} 点 | ${run.rendered ? '已出片' : '未出片'} | ${run.episodeDir}`);
          }
        }
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const projectId = String(args?.projectId || '');
      const limit = Math.max(1, Number(args?.limit || 100));
      const includeDeleted = args?.includeDeleted === true;
      const blockers = [];
      let runs = [];
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const token = await loginToken(base, credentialsOf(cfg));
      let viewerId = String(authStatus().userId || '');
      if (!viewerId && token) {
        const me = await httpJson(`${base}/api/v1/users/me`, { token }).catch(() => null);
        viewerId = String(me?.json?.data?.id ?? me?.json?.data?.user_id ?? '');
      }
      try {
        const files = readdirSync(stateDir()).filter((n) => n.endsWith('.json') && !n.includes('.tmp-'));
        for (const file of files) {
          try {
            const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
            if (!state?.runId) continue;
            if (!viewerId) continue;
            if (!localRunVisible(state, authStatus())) continue;
            if (projectId && state.projectId !== projectId) continue;
            runs.push(summarizeRun(state));
          } catch {
            /* skip broken state */
          }
        }
      } catch {
        blockers.push('读取 state 目录失败');
      }
      if (!includeDeleted) {
        runs = await filterRunsByBackendProject(base, token, runs);
      }
      runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const capped = runs.slice(0, limit);
      const groups = groupRunsByProject(capped);
      const spent = capped.reduce((sum, run) => sum + run.spent, 0);
      return { ok: blockers.length === 0, totalRuns: capped.length, spent, groups, blockers };
    },
  });
}
