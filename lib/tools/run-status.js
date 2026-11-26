import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nextAction as decideNextAction } from '../decisions.js';
import { DEFAULT_API, configOf } from '../config.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { lookupRunStatus } from '../story/client.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_run_status',
        description:
          '读取 state 并汇总一次 run 的进度：分析任务状态/进度、集状态、资产数、分镜数。不写任何数据。',
        parameters: {
          runId: { type: 'string', description: 'run_start 返回的 runId' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              stage: { type: 'string' },
              analysisStatus: { type: 'string' },
              progress: { type: 'number' },
              episodeStatus: { type: 'string' },
              assetsCount: { type: 'number' },
              assetsWithImage: { type: 'number' },
              shotsCount: { type: 'number' },
              videoCount: { type: 'number' },
              nextAction: { type: 'string' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(`run ${value.runId}: ${value.stage}`);
            if (value.analysisStatus) lines.push(`- 分析任务: ${value.analysisStatus} (${value.progress}%)`);
            if (value.episodeStatus) lines.push(`- 集状态: ${value.episodeStatus}`);
            lines.push(`- 资产: ${value.assetsCount}（有图 ${value.assetsWithImage}）/ 分镜: ${value.shotsCount}（视频 ${value.videoCount}）`);
            if (value.nextAction) lines.push(`- 下一步: ${value.nextAction}`);
            if (value.blockers?.length) {
              for (const b of value.blockers) lines.push(`  · ${b}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const runId = String(args?.runId || '');
          const blockers = [];
          const state = readRunState(runId);
          if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);

          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          const status = state && token ? await lookupRunStatus(base, token, state) : { stage: 'UNKNOWN', analysisStatus: '', progress: 0, episodeStatus: '', assetsCount: 0, assetsWithImage: 0, shotsCount: 0, videoCount: 0 };
          const nextAction = state && state.needHuman
            ? 'confirm-assets'
            : decideNextAction({
                analysisStatus: status.analysisStatus,
                assetsWithImage: status.assetsWithImage,
                assetsTotal: status.assetsGeneratable,
                videoCount: status.videoCount,
                shotsTotal: status.shotsCount,
              });

          return compactNulls({
            ok: blockers.length === 0,
            runId,
            stage: status.stage,
            analysisStatus: status.analysisStatus,
            progress: status.progress,
            episodeStatus: status.episodeStatus,
            assetsCount: status.assetsCount,
            assetsWithImage: status.assetsWithImage,
            shotsCount: status.shotsCount,
            videoCount: status.videoCount,
            nextAction,
            blockers,
          });
        },
})
}
