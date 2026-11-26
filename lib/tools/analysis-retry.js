import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { httpJson } from '../core/http.js';
import { submitAnalyze } from '../story/client.js';
import { analysisSettingsFromMetadata } from '../story/analysis.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_analysis_retry',
    description: '重新提交某一集的分析（用于 failed / completed_with_errors / 长时间无进展），复用原剧本，使用项目最新分析设置，返回新 taskId。',
    parameters: {
      runId: { type: 'string', description: 'run_start / episode_add 返回的 runId' },
      confirm: { type: 'boolean', description: '必须由用户明确确认重提分析后传入 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          taskId: { type: 'string' },
          analyzeStatus: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`analysis_retry ${value.runId}: ${value.ok ? '已重新提交' : '失败'}`];
        if (value.taskId) lines.push(`- taskId: ${value.taskId}（${value.analyzeStatus}）`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      if (args?.confirm !== true) blockers.push('需要用户明确确认后传入 confirm=true，才能重新提交分析');
      const scriptId = String(state?.scriptId || '');
      const text = String(state?.scriptText || '');
      if (!scriptId) blockers.push('state 里没有 scriptId');
      if (!text.trim()) blockers.push('state 里没有 scriptText，无法重提');

      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      let projectMeta = null;
      if (token && state?.projectId) {
        const projectRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token }).catch(() => null);
        projectMeta = projectRes?.json?.data?.metadata && typeof projectRes.json.data.metadata === 'object'
          ? projectRes.json.data.metadata
          : null;
        if (state.requiresSettingsConfirmation || state.stage === 'SETTINGS_PENDING') {
          if (!projectMeta || !String(projectMeta.harnessSettingsCompletedAt || '')) {
            blockers.push('请先在任务列表完成项目设置并保存，再提交分析');
          }
        }
      }

      let taskId = '';
      let analyzeStatus = '';
      if (!blockers.length) {
        const settings = projectMeta
          ? analysisSettingsFromMetadata(projectMeta)
          : analysisSettingsFromMetadata(state.settings || {});
        const stylePrompt = projectMeta
          ? String(projectMeta.defaultStyleWikiPrompt?.promptTemplate || state.settings?.styleText || '')
          : String(state.settings?.styleText || '');
        const mode = projectMeta
          ? String(projectMeta.scriptProcessingMode || state.settings?.scriptProcessingMode || 'script_standard')
          : String(state.settings?.scriptProcessingMode || 'script_standard');
        const an = await submitAnalyze(base, token, scriptId, {
          text,
          stylePrompt,
          mode,
          episodeNo: Number(state.episodeNo) || 1,
          analysis: settings,
        });
        taskId = an.taskId;
        analyzeStatus = an.statusText || String(an.status);
        if (an.status !== 200 && an.status !== 201) blockers.push(`提交分析失败（${an.status}）`);
      }
      if (taskId && !blockers.length) {
        writeRunState(runId, {
          ...state,
          taskId,
          stage: 'ANALYSIS_SUBMITTED',
          analysisRetryAt: new Date().toISOString(),
        });
      }
      return compactNulls({ ok: blockers.length === 0, runId, taskId, analyzeStatus, blockers });
    },
  });
}
