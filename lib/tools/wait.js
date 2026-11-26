import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { submitAnalyze } from '../story/client.js';
import { compactNulls } from '../core/util.js';
import { isAutonomyEnabled } from '../core/autonomy.js';
import { auditShotContract } from '../story/contract.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function createTool(config) {
  return defineTool({
    name: 'myreels_wait',
    description: '轮询分析任务直到完成/失败或超时（免费）：适合 60 分钟级分析，多次调用即可，不必手动循环。',
    parameters: {
      runId: { type: 'string', description: 'run_start / episode_add 返回的 runId' },
      timeoutSec: { type: 'number', description: '本次最多等待秒数（默认 60，上限 600）' },
      intervalSec: { type: 'number', description: '轮询间隔秒（默认 15）' },
      autoRetry: { type: 'boolean', description: '分析因 R2/SSL 等传输错误失败时自动重提（默认 true，最多 2 次）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          status: { type: 'string' },
          done: { type: 'boolean' },
          waitedSec: { type: 'number' },
          taskId: { type: 'string' },
          retries: { type: 'number' },
          earlyWarnings: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`wait ${value.runId}: ${value.status}${value.done ? '（完成）' : `（等待 ${value.waitedSec}s）`}`];
        for (const w of value.earlyWarnings || []) lines.push(`  ⚠ ${w}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const timeoutSec = Math.min(600, Math.max(5, Number(args?.timeoutSec || 60)));
      const intervalSec = Math.max(3, Number(args?.intervalSec || 15));
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      let taskId = String(state?.taskId || '');
      if (!taskId && !state?.episodeId) blockers.push('该 run 没有分析 taskId');
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      if (token && !taskId && state?.episodeId) {
        const epsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/episodes?page=1&limit=200`, { token });
        const ep = (epsRes.json?.data?.items || []).find((x) => String(x.id) === String(state.episodeId)) || null;
        const epStatus = String(ep?.scriptAnalysisStatus || ep?.status || 'unknown');
        const finished = ['completed', 'completed_with_errors', 'failed'].includes(epStatus);
        return compactNulls({
          ok: true,
          runId,
          status: epStatus,
          done: finished,
          waitedSec: 0,
          retries: 0,
          earlyWarnings: ['该 run 接自 WebUI 既有项目，没有本地分析任务，按集状态判定，不会重提分析'],
          blockers,
        });
      }
      const autoRetry = args?.autoRetry !== false && isAutonomyEnabled('transient_retry');
      let retries = 0;

      let status = String(state?.stage || 'UNKNOWN');
      let done = false;
      const started = Date.now();
      const deadline = started + timeoutSec * 1000;
      while (!blockers.length && Date.now() < deadline) {
        const r = await httpJson(`${base}/api/v1/tasks/${taskId}`, { token });
        const data = r.json?.data || {};
        status = String(data.status || data.task?.status || 'unknown');
        if (['completed', 'failed', 'cancelled', 'completed_with_errors'].includes(status)) {
          const err = String(data.errorMessage || data.error || '');
          const retryable = autoRetry && retries < 2 && /SSL|R2|cloudflarestorage|Unexpected|timeout|ECONN/i.test(err);
          if (status === 'failed' && retryable && state?.scriptText) {
            const an = await submitAnalyze(base, token, String(state.scriptId || ''), {
              text: String(state.scriptText || ''),
              stylePrompt: String(state.settings?.styleText || ''),
              mode: String(state.settings?.scriptProcessingMode || 'script_standard'),
              episodeNo: Number(state.episodeNo) || 1,
            });
            if (an.taskId) {
              taskId = an.taskId;
              retries += 1;
              writeRunState(runId, { ...readRunState(runId), taskId, stage: 'ANALYSIS_SUBMITTED', analysisAutoRetryAt: new Date().toISOString() });
              if (Date.now() + intervalSec * 1000 > deadline) break;
              await sleep(intervalSec * 1000);
              continue;
            }
          }
          done = true;
          break;
        }
        if (Date.now() + intervalSec * 1000 > deadline) break;
        await sleep(intervalSec * 1000);
      }
      const earlyWarnings = [];
      if (done && status === 'completed' && state?.episodeId && isAutonomyEnabled('preflight_gate')) {
        try {
          const [shotsRes, toolsRes] = await Promise.all([
            httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token }),
            httpJson(`${base}/api/v1/tools?limit=400`, { token }),
          ]);
          const shots = shotsRes.json?.data?.items || [];
          const toolItems = toolsRes.json?.data?.items || [];
          const requested = String(state.settings?.videoModelSlug || cfg.videoModelSlug || '');
          const videoTool = toolItems.find((x) => String(x.slug) === requested)
            || toolItems.find((x) => String(x.modelName) === requested)
            || null;
          const durations = (videoTool?.userInputSchema?.duration?.options || [])
            .map((x) => Number(x?.value ?? x))
            .filter((n) => n > 0);
          const maxDuration = durations.length ? Math.max(...durations) : 0;
          for (const shot of shots) {
            const target = Number(shot.durationSeconds) || 0;
            if (maxDuration && target > maxDuration) {
              earlyWarnings.push(`分镜 ${shot.shotNo}: 计划 ${target}s > 模型单段上限 ${maxDuration}s；请先选支持该时长的模型，或明确要求拆镜`);
            }
            const audit = auditShotContract(shot, { maxRefs: 4 });
            for (const issue of audit.issues) {
              if (issue.code === 'dialogue-too-long') earlyWarnings.push(`分镜 ${shot.shotNo}: ${issue.message}`);
            }
          }
        } catch {
          /* 预检失败不阻断分析结果 */
        }
      }
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        status,
        done,
        waitedSec: Math.round((Date.now() - started) / 1000),
        taskId,
        retries,
        earlyWarnings,
        blockers,
      });
    },
  });
}
