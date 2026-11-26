import { readdirSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { stateDir, readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';

const MODES = ['manual', 'auto', 'off'];

export default function createTool(config) {
  return defineTool({
    name: 'myreels_review_mode',
    description: '查看/切换资产审查模式：manual（默认，生成资产前需人工确认）、auto（自动确认）、off（不审查）。同时写入项目 metadata 和该项目所有本地 run，使已有 run 立即跟随。',
    parameters: {
      mode: { type: 'string', description: 'manual / auto / off（可空=只查看当前模式）' },
      runId: { type: 'string', description: 'run_start 返回的 runId（可空；与 projectId 二选一）' },
      projectId: { type: 'string', description: '故事项目 id（可空；与 runId 二选一）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          projectId: { type: 'string' },
          updatedRuns: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const label = value.mode === 'manual' ? '人工确认' : value.mode === 'auto' ? '自动确认' : value.mode === 'off' ? '不审查' : '未设置';
        const lines = [`review_mode: ${label}（${value.mode || '?'}）`];
        if (value.projectId) lines.push(`- 项目: ${value.projectId}`);
        if (value.updatedRuns) lines.push(`- 同步本地 run: ${value.updatedRuns}`);
        for (const b of value.blockers || []) lines.push(`- ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const blockers = [];
      const state = args?.runId ? readRunState(String(args.runId)) : null;
      const projectId = String(args?.projectId || state?.projectId || '');
      const mode = String(args?.mode || '').trim();
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      if (!projectId) blockers.push('需要 runId 或 projectId');
      if (mode && !MODES.includes(mode)) blockers.push('mode 必须是 manual / auto / off');
      if (!projectId || !token || blockers.length) return compactNulls({ ok: false, mode, projectId, blockers });

      const res = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
      if (res.status !== 200) {
        return compactNulls({ ok: false, mode, projectId, blockers: [`项目不可读（${res.status}）`] });
      }
      const metadata = { ...(res.json?.data?.metadata || {}) };
      const current = String(metadata.assetReview || (state?.settings?.assetReview) || 'manual');
      if (!mode) return compactNulls({ ok: true, mode: current, projectId, updatedRuns: 0 });

      metadata.assetReview = mode;
      const saved = await httpJson(`${base}/api/v1/story-projects/${projectId}`, {
        method: 'PUT',
        token,
        body: { metadata },
      });
      if (saved.status !== 200) blockers.push(`保存项目设置失败（${saved.status}）`);

      let updatedRuns = 0;
      if (!blockers.length) {
        for (const name of readdirSync(stateDir()).filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))) {
          const runState = readRunState(name.replace(/\.json$/, ''));
          if (!runState || String(runState.projectId || '') !== projectId) continue;
          writeRunState(runState.runId, {
            ...runState,
            settings: { ...(runState.settings || {}), assetReview: mode },
          });
          updatedRuns += 1;
        }
      }

      return compactNulls({ ok: blockers.length === 0, mode, projectId, updatedRuns, blockers });
    },
  });
}
