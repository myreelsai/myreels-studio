import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { layoutOfState } from '../storage/layout.js';
import { runFfmpeg, probeDurationSec } from '../media/ffmpeg.js';

function segmentDir(layout, shotNo) {
  return join(layout.shotsDir, `shot-${String(shotNo).padStart(2, '0')}`);
}

function listSegments(layout, shotNo) {
  const dir = segmentDir(layout, shotNo);
  try {
    return readdirSync(dir)
      .filter((name) => /^seg-\d+\.mp4$/.test(name))
      .sort()
      .map((name) => ({ name, path: join(dir, name), durationSec: Number(probeDurationSec(join(dir, name))) || 0 }));
  } catch {
    return [];
  }
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_segments',
    description: '分镜分段原语：list 查看本地分段、save 把当前最新视频存为下一段、concat 把该镜所有分段拼成 shot-XX.mp4；段数与取舍由 Agent 决定。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      shotNo: { type: 'number', description: '分镜号' },
      action: { type: 'string', description: 'list / save / concat（默认 list）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          shotNo: { type: 'number' },
          action: { type: 'string' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                durationSec: { type: 'number' },
              },
            },
          },
          savedPath: { type: 'string' },
          concatPath: { type: 'string' },
          durationSec: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`segments ${value.action} ${value.runId} 分镜 ${value.shotNo}: ${value.segments.length} 段`];
        for (const seg of value.segments) lines.push(`  · ${seg.name}（${seg.durationSec}s）`);
        if (value.savedPath) lines.push(`- 已存: ${value.savedPath}`);
        if (value.concatPath) lines.push(`- 已拼: ${value.concatPath}（${value.durationSec}s）`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const shotNo = Number(args?.shotNo || 0);
      const action = String(args?.action || 'list');
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const layout = layoutOfState(state);
      if (!layout) blockers.push('无法确定目录');
      let segments = [];
      let savedPath = '';
      let concatPath = '';
      let durationSec = 0;

      if (layout && state && shotNo) {
        if (action === 'list' || action === 'concat') segments = listSegments(layout, shotNo);
        if (action === 'list') {
          /* nothing */
        } else if (action === 'concat') {
          if (segments.length < 1) blockers.push('没有本地分段可拼');
          if (segments.length >= 1) {
            const out = join(layout.shotsDir, `shot-${String(shotNo).padStart(2, '0')}.mp4`);
            mkdirSync(layout.shotsDir, { recursive: true });
            try {
              if (segments.length === 1) {
                const { copyFileSync } = await import('node:fs');
                copyFileSync(segments[0].path, out);
              } else {
                const tmp = join(layout.shotsDir, `concat-${shotNo}.txt`);
                writeFileSync(tmp, segments.map((s) => `file '${s.path.replace(/\\/g, '/')}'`).join('\n'));
                runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', tmp, '-c', 'copy', out]);
              }
              concatPath = out;
              durationSec = Number(probeDurationSec(out)) || 0;
            } catch (error) {
              blockers.push(`拼接失败：${String(error?.message || error)}`);
            }
          }
        } else if (action === 'save') {
          const token = await loginToken(base, credentialsOf(cfg));
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
          if (token) {
            const shots = (await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token })).json?.data?.items || [];
            const shot = shots.find((s) => Number(s.shotNo) === shotNo);
            if (!shot) blockers.push(`找不到分镜 ${shotNo}`);
            const video = shot?.outputs?.latestVideo;
            if (!shot || !video || video.status !== 'completed') blockers.push('该分镜没有已完成视频');
            if (shot && video?.status === 'completed' && !blockers.length) {
              let url = '';
              if (video.userFileId) {
                const dl = await httpJson(`${base}/api/v1/user-files/download/${video.userFileId}`, { token });
                if (typeof dl.json?.data === 'string') url = dl.json.data;
              }
              if (!url && video.url) url = String(video.url).startsWith('http') ? video.url : `https://image.myreels.tv/${String(video.url).replace(/^\/+/, '')}`;
              const buf = url ? await fetchBinary(url) : null;
              if (!buf) blockers.push('下载视频失败');
              if (buf) {
                const dir = segmentDir(layout, shotNo);
                mkdirSync(dir, { recursive: true });
                const existing = listSegments(layout, shotNo);
                const index = existing.length + 1;
                const file = join(dir, `seg-${String(index).padStart(2, '0')}.mp4`);
                writeFileSync(file, buf);
                savedPath = file;
                durationSec = Number(probeDurationSec(file)) || 0;
                segments = listSegments(layout, shotNo);
              }
            }
          }
        } else {
          blockers.push(`未知 action：${action}`);
        }
      } else if (!shotNo) {
        blockers.push('需要 shotNo');
      }

      return compactNulls({ ok: blockers.length === 0, runId, shotNo, action, segments, savedPath, concatPath, durationSec, blockers });
    },
  });
}
