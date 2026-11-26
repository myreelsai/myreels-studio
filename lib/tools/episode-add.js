import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { resolveOwner, ownerFields, localProjectVisible } from '../core/owner.js';
import { writeRunState, projectSpentPoints, stateDir } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { createEpisode, createScript, submitAnalyze } from '../story/client.js';
import { analysisReviewMode, analysisSettingsFromMetadata, analysisSettingsText, needsAnalysisConfirmation, projectSettingsReady } from '../story/analysis.js';
import { join } from 'node:path';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_episode_add',
    description: '在已有项目下新建一集（可多集连续调用）：建集 → 建剧本；分析默认等待用户确认（ANALYSIS_PENDING），确认后调用 myreels_analysis_confirm；继承项目设置。用于一部剧多集。',
    parameters: {
      projectId: { type: 'string', description: '已有故事项目 id' },
      groupId: { type: 'number', description: '画布组 id（可空=自动继承同项目 run）' },
      episodeNo: { type: 'number', description: '集号' },
      script: { type: 'string', description: '本集剧本全文（与 scriptPath 二选一）' },
      scriptPath: { type: 'string', description: '本集剧本文件路径' },
      aspect: { type: 'string', description: '画幅（可空=项目 settings）' },
      budgetPoints: { type: 'number', description: '本集预算（可空=项目元数据）' },
      imageModelSlug: { type: 'string', description: '图片模型 slug（可空=项目/默认）' },
      videoModelSlug: { type: 'string', description: '视频模型 slug（可空=项目/默认）' },
      analysisReview: { type: 'string', description: 'manual / auto（默认继承项目，缺省 manual）' },
      confirmAnalysis: { type: 'boolean', description: '用户已确认分析参数时传 true；manual 模式下不传则只建剧本' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          projectId: { type: 'string' },
          episodeId: { type: 'string' },
          episodeNo: { type: 'number' },
          scriptId: { type: 'string' },
          taskId: { type: 'string' },
          analyzeStatus: { type: 'string' },
          analysisPending: { type: 'boolean' },
          analysisSettings: { type: 'string' },
          statePath: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`episode_add ${value.projectId} EP${value.episodeNo}: ${value.ok ? '已创建' : '失败'}`];
        if (value.runId) lines.push(`- runId: ${value.runId}`);
        if (value.taskId) lines.push(`- taskId: ${value.taskId}（${value.analyzeStatus}）`);
        if (value.analysisPending) { lines.push('- 分析: 等待用户确认，尚未提交'); if (value.analysisSettings) lines.push(`- 参数: ${value.analysisSettings}`); }
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const projectId = String(args?.projectId || '');
      const episodeNo = Number(args?.episodeNo || 0);
      let text = String(args?.script || '');
      const blockers = [];
      if (!projectId) blockers.push('缺少 projectId');
      if (!episodeNo) blockers.push('缺少 episodeNo');
      if (!text && args?.scriptPath) {
        try {
          text = readFileSync(String(args.scriptPath), 'utf8');
        } catch (error) {
          blockers.push(`读剧本失败：${String(error?.message || error)}`);
        }
      }
      if (!text.trim()) blockers.push('缺少剧本（script 或 scriptPath）');

      const token = await loginToken(base, credentialsOf(cfg));
      const owner = await resolveOwner(base, token);
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      if (projectId && token) {
        try {
          for (const name of readdirSync(stateDir())) {
            if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
            const s = JSON.parse(readFileSync(join(stateDir(), name), 'utf8'));
            if (String(s?.projectId || '') !== projectId) continue;
            if (!['ANALYSIS_SUBMITTED', 'ANALYZING'].includes(String(s.stage || ''))) continue;
            const t = await httpJson(`${base}/api/v1/tasks/${s.taskId}`, { token });
            const status = String(t.json?.data?.status || '');
            if (['queued', 'processing', 'running', 'pending'].includes(status)) {
              blockers.push(`项目已有分析在跑（run ${String(s.runId).slice(0, 8)}，${status}），先 myreels_wait`);
            }
          }
        } catch {
          /* state 读不到则跳过 */
        }
      }

      let project = null;
      if (!blockers.length) {
        const r = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
        if (r.status !== 200) blockers.push(`项目不可读（${r.status}）`);
        project = r.json?.data || null;
      }
      const meta = project?.metadata && typeof project.metadata === 'object' ? project.metadata : {};
      if (!localProjectVisible(projectId, meta)) blockers.push('当前操作者无权访问该项目');
      if (!projectSettingsReady(meta)) blockers.push('请先到任务列表打开项目设置并保存，完成项目设置后再创建/分析下一集');
      const projectBudget = Number(meta.runBudgetPoints || 0);
      const effectiveBudget = Number(args?.budgetPoints || projectBudget || 0);
      if (effectiveBudget > 0 && projectId) {
        const spent = projectSpentPoints(projectId);
        if (spent >= effectiveBudget) blockers.push(`项目预算已满（${spent}/${effectiveBudget}），需上调预算`);
      }
      const settings = {
        aspect: String(args?.aspect || meta.defaultVideoRatio || '9:16'),
        styleText: String(meta.defaultStyleWikiPrompt?.promptTemplate || ''),
        stylePageId: String((meta.defaultStyleWikiPromptIds || [])[0] || ''),
        budgetPoints: effectiveBudget,
        assetReview: String(meta.assetReview || 'manual'),
        analysisReview: String(args?.analysisReview || meta.analysisReview || 'manual'),
        scriptProcessingMode: String(meta.scriptProcessingMode || meta.script_processing_mode || 'director_storyboard'),
        imageModelSlug: String(args?.imageModelSlug || meta.imageModelSlug || cfg.imageModelSlug),
        videoModelSlug: String(args?.videoModelSlug || meta.defaultMultiVideoModel || meta.defaultVideoModel || meta.videoModelSlug || cfg.videoModelSlug),
        analysisSettings: analysisSettingsFromMetadata(meta),
      };

      let episodeId = '';
      let scriptId = '';
      let taskId = '';
      let analyzeStatus = '';
      let statePath = '';
      if (!blockers.length) {
        const existingRes = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes?page=1&limit=200`, { token });
        if (existingRes.status !== 200) blockers.push(`读取已有剧集失败（${existingRes.status}）`);
        const existing = (existingRes.json?.data?.items || []).find((x) => Number(x.episodeNo) === episodeNo);
        if (existing?.id) {
          episodeId = String(existing.id);
        } else {
          const ep = await createEpisode(base, token, projectId, episodeNo);
          episodeId = ep.id;
          if (!episodeId) blockers.push(`建集失败（${ep.status}）`);
        }
      }
      if (!blockers.length && episodeId) {
        const sc = await createScript(base, token, episodeId, text);
        scriptId = sc.id;
        if (!scriptId) blockers.push(`建剧本失败（${sc.status}）`);
      }
      if (!blockers.length && scriptId) {
        const pending = needsAnalysisConfirmation({ ...meta, analysisReview: settings.analysisReview }, args);
        if (pending) {
          analyzeStatus = 'pending-confirmation';
        } else {
          const an = await submitAnalyze(base, token, scriptId, {
            text,
            stylePrompt: settings.styleText,
            mode: settings.scriptProcessingMode,
            episodeNo,
            analysis: analysisSettingsFromMetadata(meta),
          });
          taskId = an.taskId;
          analyzeStatus = an.statusText || String(an.status);
          if (an.status !== 200 && an.status !== 201) blockers.push(`提交分析失败（${an.status}）`);
        }
      }

      const runId = randomUUID();
      if (!blockers.length) {
        let groupId = Number(args?.groupId || 0);
        let canvasProjectId = 0;
        try {
          for (const name of readdirSync(stateDir())) {
            if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
            const s = JSON.parse(readFileSync(join(stateDir(), name), 'utf8'));
            if (String(s?.projectId || '') !== projectId) continue;
            if (!groupId && s.groupId) groupId = Number(s.groupId);
            if (!canvasProjectId && s.canvasProjectId) canvasProjectId = Number(s.canvasProjectId);
          }
        } catch {
          /* 继承失败不影响建集 */
        }
        statePath = writeRunState(runId, {
          runId,
          projectId,
          projectTitle: String(project?.title || ''),
          groupId,
          canvasProjectId,
          episodeId,
          scriptId,
          episodeNo,
          scriptText: text.slice(0, 20000),
          taskId,
          stage: analyzeStatus === 'pending-confirmation' ? 'ANALYSIS_PENDING' : 'ANALYSIS_SUBMITTED',
          settings,
          ...ownerFields(owner),
          createdAt: new Date().toISOString(),
        });
      }

      return compactNulls({
        ok: blockers.length === 0,
        runId: blockers.length ? '' : runId,
        projectId,
        episodeId,
        episodeNo,
        scriptId,
        taskId,
        analyzeStatus,
        analysisPending: analyzeStatus === 'pending-confirmation',
        analysisSettings: analysisSettingsText(analysisSettingsFromMetadata({ ...meta, analysisReview: settings.analysisReview })),
        statePath,
        blockers,
      });
    },
  });
}
