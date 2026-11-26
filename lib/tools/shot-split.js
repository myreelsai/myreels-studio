import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { splitShotPrompt } from '../story/split.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_shot_split',
    description: '仅在明确要求时使用的特殊操作：把现有 30s 分镜拆成两段 15s（不重新分析）。默认按原始分镜时长一次生成，不要主动调用。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      shotNo: { type: 'number', description: '要拆的分镜号' },
      splitSec: { type: 'number', description: '前半段秒数（默认 15）' },
      force: { type: 'boolean', description: '已有视频也强制拆（默认 false）' },
      dryRun: { type: 'boolean', description: '只返回两段提示词，不写平台（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          shotNo: { type: 'number' },
          firstShotId: { type: 'string' },
          secondShotId: { type: 'string' },
          firstSec: { type: 'number' },
          secondSec: { type: 'number' },
          firstPrompt: { type: 'string' },
          secondPrompt: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const prefix = args?.dryRun === true ? 'shot_split 预览' : 'shot_split';
        const lines = [`${prefix} 分镜 ${value.shotNo}: ${value.ok ? '已拆成两段' : '失败'}（${value.firstSec}s + ${value.secondSec}s）`];
        if (value.firstShotId) lines.push(`- 前半段: ${value.firstShotId}`);
        if (value.secondShotId) lines.push(`- 后半段: ${value.secondShotId}`);
        if (value.firstPrompt) lines.push(`- 前半段提示词预览: ${value.firstPrompt.slice(0, 160)}...`);
        if (value.secondPrompt) lines.push(`- 后半段提示词预览: ${value.secondPrompt.slice(0, 160)}...`);
        for (const warning of value.warnings || []) lines.push(`  · ${warning}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const shotNo = Number(args?.shotNo || 0);
      const splitSec = Math.max(3, Number(args?.splitSec || 15));
      const blockers = [];
      const warnings = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      let firstShotId = '';
      let secondShotId = '';
      let secondSec = 0;

      if (state && token && shotNo) {
        const res = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const shots = res.json?.data?.items || [];
        const index = shots.findIndex((s) => Number(s.shotNo) === shotNo);
        const shot = shots[index];
        if (!shot) blockers.push(`找不到分镜 ${shotNo}`);
        if (shot?.outputs?.latestVideo?.status === 'completed' && args?.force !== true && args?.dryRun !== true) {
          blockers.push('该分镜已有视频；确认要拆请传 force=true');
        }
        if (shot && !blockers.length) {
          const split = splitShotPrompt(shot.prompt || shot.description || '', splitSec);
          const firstPrompt = String(split.first || '').replace(/^##\s*分镜[^｜|]*[｜|]/, `## 分镜${shotNo}｜`);
          const secondPrompt = String(split.second || '').replace(/^##\s*分镜[^｜|]*[｜|]/, `## 分镜${shotNo + 1}｜`);
          warnings.push(...split.warnings);
          secondSec = Math.max(1, (Number(shot.durationSeconds) || 30) - splitSec);
          if (!split.second) blockers.push('拆分结果为空（可能没有时间切点）');
          if (args?.dryRun === true) {
            return compactNulls({
              ok: blockers.length === 0,
              runId,
              shotNo,
              firstSec: splitSec,
              secondSec,
              firstPrompt,
              secondPrompt,
              warnings,
              blockers,
            });
          }
          if (!blockers.length) {
            const put = await httpJson(`${base}/api/v1/story-shots/${shot.id}`, {
              method: 'PUT',
              token,
              body: { prompt: firstPrompt, durationSeconds: splitSec },
            });
            if (put.status !== 200) blockers.push(`更新前半段失败（${put.status}）`);
            if (put.status === 200) {
              const created = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, {
                method: 'POST',
                token,
                body: {
                  prompt: secondPrompt,
                  durationSeconds: secondSec,
                  title: `${String(shot.title || '')}（下）`,
                  insertIndex: index + 1,
                },
              });
              const createdShot = created.json?.data;
              secondShotId = String(createdShot?.id || '');
              if (!secondShotId) blockers.push(`新建后半段失败（${created.status}）`);
              if (secondShotId) {
                firstShotId = shot.id;
                const latest = (await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token })).json?.data?.items || [];
                const ids = latest.map((s) => s.id).filter((id) => id !== secondShotId);
                const insertAt = ids.indexOf(shot.id);
                ids.splice(insertAt + 1, 0, secondShotId);
                await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots/reorder`, {
                  method: 'PUT',
                  token,
                  body: { orderedShotIds: ids },
                });
              }
            }
          }
        }
      } else if (!shotNo) {
        blockers.push('需要 shotNo');
      }

      return compactNulls({
        ok: blockers.length === 0,
        runId,
        shotNo,
        firstShotId,
        secondShotId,
        firstSec: splitSec,
        secondSec,
        warnings,
        blockers,
      });
    },
  });
}
