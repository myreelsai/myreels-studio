import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';
import { compactNulls } from '../core/util.js';
import { probeDurationSec } from '../media/ffmpeg.js';
import { parseShotCues, scaleCues, buildSrt } from '../story/subtitle.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_subtitle',
    description: '按分镜脚本时间段生成字幕 SRT（用视频实际时长缩放），不调用外部 ASR；可交给 myreels_render 的 subtitles 参数烧录。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      outPath: { type: 'string', description: '输出 srt 路径（可空，默认 <产物根>/<剧名>/epNN/epNN.srt）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          path: { type: 'string' },
          shots: { type: 'number' },
          cues: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`subtitle ${value.runId}: ${value.cues} 条 / ${value.shots} 镜`];
        if (value.path) lines.push(`- 文件: ${value.path}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
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

      const dir = mkdtempSync(join(tmpdir(), 'myreels-sub-'));
      const allCues = [];
      let shots = 0;
      let itemCount = 0;
      let videoCount = 0;
      let downloaded = 0;
      let lastStatus = '';
      let lastText = '';
      try {
        if (state && token && !blockers.length) {
          const res = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
          lastStatus = String(res.status);
          lastText = String(res.text || '').slice(0, 120);
          const items = res.json?.data?.items || [];
          itemCount = items.length;
          let offset = 0;
          for (const shot of items) {
            const v = shot.outputs?.latestVideo;
            if (!v || v.status !== 'completed') continue;
            videoCount += 1;
            let url = '';
            if (v.userFileId) {
              const d = await httpJson(`${base}/api/v1/user-files/download/${v.userFileId}`, { token });
              if (typeof d.json?.data === 'string') url = d.json.data;
            }
            if (!url) continue;
            const buf = await fetchBinary(url);
            if (!buf) continue;
            downloaded += 1;
            const file = join(dir, `shot-${shot.shotNo || shots + 1}.mp4`);
            writeFileSync(file, buf);
            const duration = probeDurationSec(file);
            const raw = parseShotCues(shot.prompt || shot.description);
            if (!raw.length || !Number.isFinite(duration) || duration <= 0) continue;
            const span = Math.max(...raw.map((c) => c.end));
            const scaled = scaleCues(raw, duration, span);
            for (const cue of scaled) {
              allCues.push({ start: cue.start + offset, end: cue.end + offset, text: cue.text });
            }
            offset += duration;
            shots += 1;
          }
        }
        if (!allCues.length) blockers.push(`没有可生成字幕的分镜视频（items=${itemCount}, videos=${videoCount}, downloaded=${downloaded}, http=${lastStatus}）${lastText}`);
        let outPath = String(args?.outPath || '');
        if (!outPath) outPath = layoutOfState(state)?.subtitlePath || join(runsRoot(), '.subtitles', `${runId}.srt`);
        if (allCues.length) {
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, buildSrt(allCues), 'utf8');
          if (state) writeRunState(runId, { ...state, subtitlePath: outPath, subtitleAt: new Date().toISOString() });
        }
        return compactNulls({ ok: blockers.length === 0, runId, path: outPath, shots, cues: allCues.length, blockers });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
