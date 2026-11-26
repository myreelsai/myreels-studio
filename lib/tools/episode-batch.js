import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { resolveOwner, ownerFields, localProjectVisible } from '../core/owner.js';
import { writeRunState, projectSpentPoints, stateDir } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { createEpisode, createScript, submitAnalyze } from '../story/client.js';
import { classifyScript, validateNormalScript } from '../story/script-format.js';
import { analysisSettingsFromMetadata, needsAnalysisConfirmation, projectSettingsReady } from '../story/analysis.js';

function inferEpisodeNo(entry, text) {
  const explicit = Number(entry?.episodeNo);
  if (explicit > 0) return explicit;
  const name = String(entry?.scriptPath || entry?.path || '');
  const fromName = name.match(/(?:^|[\\/])EP?\s*(\d+)(?:\D|$)/i) || name.match(/第\s*(\d+)\s*集/);
  if (fromName) return Number(fromName[1]);
  const fromText = String(text || '').match(/^\s*第\s*(\d+)\s*集/m);
  return fromText ? Number(fromText[1]) : 0;
}

function readEntryText(entry) {
  if (entry?.script) return String(entry.script);
  const p = String(entry?.scriptPath || entry?.path || '');
  if (!p) return '';
  return readFileSync(p, 'utf8');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_episode_batch',
    description: '批量创建多集/剧本（免费阶段）：按 project settings.analysisParallelism 并发创建；分析默认等待用户确认（ANALYSIS_PENDING），确认后逐集调用 myreels_analysis_confirm。',
    parameters: {
      projectId: { type: 'string', description: '已有故事项目 id' },
      episodes: {
        type: 'array',
        description: '要提交的集列表；每项 {episodeNo, scriptPath} 或 {episodeNo, script}',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            episodeNo: { type: 'number' },
            script: { type: 'string' },
            scriptPath: { type: 'string' },
          },
        },
      },
      scriptPaths: { type: 'array', items: { type: 'string' }, description: '可选的脚本路径数组；集号从文件名/首行推断' },
      parallelism: { type: 'number', description: '本次并发上限（可空=项目 analysisParallelism）' },
      analysisReview: { type: 'string', description: 'manual / auto（默认继承项目）' },
      confirmAnalysis: { type: 'boolean', description: '用户已确认分析参数时传 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          projectId: { type: 'string' },
          parallelism: { type: 'number' },
          submitted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string' },
                episodeNo: { type: 'number' },
                taskId: { type: 'string' },
                analyzeStatus: { type: 'string' },
                analysisPending: { type: 'boolean' },
              },
            },
          },
          failed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                episodeNo: { type: 'number' },
                error: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`episode_batch ${value.projectId}: 已提交 ${value.submitted.length} 集（并发 ${value.parallelism}）`];
        for (const x of value.submitted) lines.push(`- EP${x.episodeNo}: run ${x.runId.slice(0, 8)} / task ${x.taskId || '-'} / ${x.analyzeStatus || '-'}${x.analysisPending ? ' / 待确认' : ''}`);
        for (const x of value.failed || []) lines.push(`- EP${x.episodeNo || '?'}: 失败 ${x.error}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const projectId = String(args?.projectId || '');
      const blockers = [];
      const token = await loginToken(base, credentialsOf(cfg));
      const owner = await resolveOwner(base, token);
      if (!projectId) blockers.push('缺少 projectId');
      if (!token) blockers.push('缺少有效的登录态');
      if (blockers.length) return { ok: false, projectId, parallelism: 1, submitted: [], failed: [], blockers };

      const projectRes = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
      if (projectRes.status !== 200) blockers.push(`项目不可读（${projectRes.status}）`);
      const project = projectRes.json?.data || null;
      const meta = project?.metadata && typeof project.metadata === 'object' ? project.metadata : {};
      if (!localProjectVisible(projectId, meta)) {
        return { ok: false, projectId, parallelism: 1, submitted: [], failed: [], blockers: ['当前操作者无权访问该项目'] };
      }
      if (!projectSettingsReady(meta)) {
        return { ok: false, projectId, parallelism: 1, submitted: [], failed: [], blockers: ['请先到任务列表打开项目设置并保存，完成项目设置后再批量创建/分析'] };
      }
      const parallelism = Math.max(1, Math.min(10, Number(args?.parallelism || meta.analysisParallelism || 5)));
      const projectBudget = Number(meta.runBudgetPoints || 0);
      const spent = projectSpentPoints(projectId);
      if (projectBudget > 0 && spent >= projectBudget) blockers.push(`项目预算已满（${spent}/${projectBudget}）`);

      const raw = Array.isArray(args?.episodes)
        ? args.episodes
        : Array.isArray(args?.scriptPaths)
          ? args.scriptPaths.map((scriptPath) => ({ scriptPath }))
          : [];
      if (!raw.length) blockers.push('没有提供要分析的集');
      if (blockers.length) return { ok: false, projectId, parallelism, submitted: [], failed: [], blockers };

      const existingRes = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes?page=1&limit=200`, { token });
      const existing = existingRes.json?.data?.items || [];
      const byNo = new Map(existing.map((x) => [Number(x.episodeNo), x]));
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
        /* 继承失败不阻断 */
      }

      const settingsFor = (episodeNo) => ({
        aspect: String(meta.defaultVideoRatio || '9:16'),
        styleText: String(meta.defaultStyleWikiPrompt?.promptTemplate || ''),
        stylePageId: String((meta.defaultStyleWikiPromptIds || [])[0] || ''),
        budgetPoints: projectBudget,
        assetReview: String(meta.assetReview || 'manual'),
        scriptProcessingMode: String(meta.scriptProcessingMode || meta.script_processing_mode || 'director_storyboard'),
        imageModelSlug: String(meta.imageModelSlug || cfg.imageModelSlug),
        videoModelSlug: String(meta.defaultMultiVideoModel || meta.defaultVideoModel || meta.videoModelSlug || cfg.videoModelSlug),
        analysisParallelism: parallelism,
        batchEpisodeNo: episodeNo,
        analysisReview: String(args?.analysisReview || meta.analysisReview || 'manual'),
        analysisSettings: analysisSettingsFromMetadata(meta),
      });

      const results = await mapLimit(raw, parallelism, async (entry) => {
        try {
          const text = readEntryText(entry);
          if (!text.trim()) throw new Error('缺少剧本');
          const episodeNo = inferEpisodeNo(entry, text);
          if (!episodeNo) throw new Error('无法推断集号');
          const format = classifyScript(text).format;
          if (format === 'normal') {
            const validation = validateNormalScript(text);
            if (!validation.ok) throw new Error(`普通本校验失败：${(validation.issues || []).filter((x) => x.level === 'error').map((x) => x.message).join('；')}`);
          }
          let episode = byNo.get(episodeNo);
          if (!episode?.id) {
            const ep = await createEpisode(base, token, projectId, episodeNo);
            if (!ep.id) throw new Error(`建集失败（${ep.status}）`);
            episode = { id: ep.id, episodeNo };
            byNo.set(episodeNo, episode);
          }
          const sc = await createScript(base, token, episode.id, text);
          if (!sc.id) throw new Error(`建剧本失败（${sc.status}）`);
          const analysisReview = String(args?.analysisReview || meta.analysisReview || 'manual');
          const pending = needsAnalysisConfirmation({ ...meta, analysisReview }, args);
          let an = { taskId: '', statusText: 'pending-confirmation', status: 200 };
          if (!pending) {
            an = await submitAnalyze(base, token, sc.id, {
              text,
              stylePrompt: settingsFor(episodeNo).styleText,
              mode: settingsFor(episodeNo).scriptProcessingMode,
              episodeNo,
              analysis: analysisSettingsFromMetadata(meta),
            });
            if (an.status !== 200 && an.status !== 201) throw new Error(`提交分析失败（${an.status}）`);
          }
          const runId = randomUUID();
          writeRunState(runId, {
            runId,
            projectId,
            projectTitle: String(project?.title || ''),
            groupId,
            canvasProjectId,
            episodeId: episode.id,
            scriptId: sc.id,
            episodeNo,
            scriptText: text.slice(0, 20000),
            taskId: an.taskId,
            stage: pending ? 'ANALYSIS_PENDING' : 'ANALYSIS_SUBMITTED',
            settings: settingsFor(episodeNo),
            ...ownerFields(owner),
          createdAt: new Date().toISOString(),
          });
          return { runId, episodeNo, taskId: an.taskId, analyzeStatus: an.statusText || String(an.status), analysisPending: pending };
        } catch (error) {
          return { episodeNo: Number(entry?.episodeNo) || 0, error: String(error?.message || error) };
        }
      });

      const submitted = results.filter((x) => x.runId);
      const failed = results.filter((x) => x.error);
      return compactNulls({ ok: failed.length === 0, projectId, parallelism, submitted, failed, blockers });
    },
  });
}
