import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { httpJson } from '../core/http.js';
import { submitAnalyze } from '../story/client.js';
import { analysisSettingsFromMetadata, analysisSettingsText } from '../story/analysis.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_analysis_confirm',
    description: '人工确认后提交某一集已创建的剧本分析任务。必须先用 ask_user_question 依次让用户确认任务设置是否完成和分析参数，并传入 settingsConfirmed=true、confirm=true；未确认或设置未保存时不会提交分析。提交时读取项目最新设置。',
    parameters: {
      runId: { type: 'string', description: 'run_start / episode_add / episode_batch 返回的 runId' },
      confirm: { type: 'boolean', description: '必须显式为 true，表示用户已确认分析参数' },
      settingsConfirmed: { type: 'boolean', description: '用户确认任务设置已完成并保存时传 true' },
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
          analysisSettings: { type: 'string' },
          needsSettingsConfirmation: { type: 'boolean' },
          settingsQuestion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              header: { type: 'string' },
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`analysis_confirm ${value.runId || ''}: ${value.ok ? '已提交' : '未提交'}`];
        if (value.analysisSettings && !value.needsSettingsConfirmation) lines.push(`- 参数: ${value.analysisSettings}`);
        if (value.needsSettingsConfirmation) lines.push('- 参数: 请在任务列表 → 项目设置中确认并保存');
        if (value.taskId) lines.push(`- taskId: ${value.taskId}（${value.analyzeStatus || 'submitted'}）`);
        if (value.settingsQuestion) {
          lines.push(`- 需要提问确认: ${value.settingsQuestion.question}`);
          for (const option of value.settingsQuestion.options || []) lines.push(`  · ${option.label}`);
        }
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
      if (args?.confirm !== true) blockers.push('需要用户明确确认分析参数后传入 confirm=true');
      const scriptId = String(state?.scriptId || '');
      const text = String(state?.scriptText || '');
      if (!scriptId) blockers.push('state 里没有 scriptId');
      if (!text.trim()) blockers.push('state 里没有 scriptText');
      if (state?.taskId) blockers.push('该 run 已有分析 taskId，不重复提交');

      let taskId = '';
      let analyzeStatus = '';
      let projectMeta = null;
      let needsSettingsConfirmation = false;
      let settingsQuestion = null;
      let settings = state?.settings?.analysisSettings
        || (state ? analysisSettingsFromMetadata(state.settings || {}) : {});
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      if (token && state?.projectId) {
        const projectRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token }).catch(() => null);
        projectMeta = projectRes?.json?.data?.metadata && typeof projectRes.json.data.metadata === 'object'
          ? projectRes.json.data.metadata
          : null;
        if (projectMeta) settings = analysisSettingsFromMetadata(projectMeta);
        if ((state.requiresSettingsConfirmation || state.stage === 'SETTINGS_PENDING') && args?.settingsConfirmed !== true) {
          needsSettingsConfirmation = true;
          settingsQuestion = {
            header: '确认任务设置',
            question: '项目设置是否已经完成并保存？请到任务列表 → 项目设置完成所有参数设置并保存，然后选择“已完成设置”。',
            options: [
              { label: '已完成设置，继续', description: '项目设置已经保存，可以提交分析' },
              { label: '还没有完成', description: '暂停，先去完成任务设置' },
            ],
          };
          blockers.push('需要用户确认任务设置已完成（settingsConfirmed=true），且项目设置已保存');
        }
        if (state.requiresSettingsConfirmation || state.stage === 'SETTINGS_PENDING') {
          if (!projectMeta || !String(projectMeta.harnessSettingsCompletedAt || '')) {
            needsSettingsConfirmation = true;
            settingsQuestion = {
              header: '确认任务设置',
              question: '请先到任务列表 → 项目设置，完成分析参数、资产模板、比例和预算等设置并保存。保存完成后确认继续。',
              options: [
                { label: '已完成设置，继续', description: '保存项目设置后再提交分析' },
                { label: '稍后处理', description: '暂不提交分析' },
              ],
            };
            blockers.push('请先在任务列表打开项目设置并保存，完成项目设置后再确认分析');
          }
        }
      }

      if (!blockers.length) {
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
          settings: { ...(state.settings || {}), analysisSettings: settings },
          analysisConfirmedAt: new Date().toISOString(),
          analysisConfirmedBy: 'user',
        });
      }
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        taskId,
        analyzeStatus,
        analysisSettings: analysisSettingsText(settings),
        needsSettingsConfirmation,
        settingsQuestion,
        blockers,
      });
    },
  });
}
