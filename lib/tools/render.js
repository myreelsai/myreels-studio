import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { qcDurationOk } from '../decisions.js';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';
import { compactNulls } from '../core/util.js';
import { runFfmpeg, detectBlackFrameCount, detectFreezeSeconds, buildSubtitleFilter, probeDurationSec, probeVideoDurationSec } from '../media/ffmpeg.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_render',
        description: '把一次 run 的分镜视频按顺序下载并用 ffmpeg 拼接为整集成片（本地 mp4）；缺视频的分镜跳过并计数；缺镜时只输出 *.partial.mp4，不覆盖正式成片。',
        parameters: {
          runId: { type: 'string', description: 'run_start 返回的 runId' },
          outPath: { type: 'string', description: '输出 mp4 路径（可空，默认 <产物根>/<剧名>/epNN/epNN.mp4）' },
          normalize: { type: 'boolean', description: '归一化到 1080x1920/30fps（默认 true）' },
          subtitles: { type: 'string', description: '烧录字幕 srt 路径（可空）' },
          subtitleFontSize: { type: 'number', description: '字幕字号（默认 18，force_style FontSize）' },
          subtitleMarginV: { type: 'number', description: '字幕底部边距（默认 80，force_style MarginV）' },
          fillMissing: { type: 'boolean', description: '缺失分镜插入 3s 黑场占位（默认 false）' },
          plannedDurationSec: { type: 'number', description: '计划集时长秒（可空=按分镜 durationSeconds 汇总；仅作对照，不做自动判定）' },
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
              durationSec: { type: 'number' },
              plannedDurationSec: { type: 'number' },
              shortfallSec: { type: 'number' },
              sizeMb: { type: 'number' },
              missing: { type: 'number' },
              degraded: { type: 'number' },
              partial: { type: 'boolean' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(value.ok ? (value.partial ? `render ${value.runId}: 已生成部分成片（未完成）` : `render ${value.runId}: 成片已生成`) : `render ${value.runId}: 失败`);
            if (value.path) lines.push(`- 文件: ${value.path}`);
            lines.push(`- 分镜: ${value.shots}（缺 ${value.missing}，QC 降级 ${value.degraded}）`);
            if (value.durationSec) lines.push(`- 时长: ${value.durationSec}s / ${value.sizeMb}MB`);
            if (value.plannedDurationSec) lines.push(`- 对照: 计划 ${value.plannedDurationSec}s / 实际 ${value.durationSec}s / 差 ${value.shortfallSec}s（由 Agent 决定是否补段）`);
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
          let missing = 0;
          let degraded = 0;
          let durationSec = 0;
          let sizeMb = 0;
          let plannedDurationSec = 0;
          let shortfallSec = 0;
          let placeholderCount = 0;
          let partial = false;
          let coveredShots = 0;

          const state = readRunState(runId);
          if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          let outPath = String(args?.outPath || '');
          const layout = layoutOfState(state);
          const shotsDir = layout?.shotsDir || '';
          if (shotsDir) mkdirSync(shotsDir, { recursive: true });
          const dir = mkdtempSync(join(tmpdir(), 'myreels-render-'));
          const files = [];
          try {
            const shots = state && token
              ? (await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token })).json?.data?.items || []
              : [];
            plannedDurationSec = Number(args?.plannedDurationSec) || shots.reduce((sum, shot) => sum + (Number(shot.durationSeconds) || 0), 0);
            let localShotFiles = [];
            try {
              localShotFiles = readdirSync(shotsDir)
                .filter((name) => /^shot-\d+\.mp4$/i.test(name))
                .sort()
                .map((name) => join(shotsDir, name));
            } catch {
              localShotFiles = [];
            }
            if (!plannedDurationSec && localShotFiles.length) {
              plannedDurationSec = Math.round(localShotFiles.reduce((sum, file) => sum + (probeVideoDurationSec(file) || 0), 0) * 10) / 10;
            }
            const fillMissing = args?.fillMissing === true;
            const addPlaceholder = (shotNo) => {
              const p = join(shotsDir || dir, `shot-${shotNo || files.length + 1}-missing.mp4`);
              runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=black:s=${cfg.render.width}x${cfg.render.height}:d=3:r=${cfg.render.fps}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', p]);
              placeholderCount += 1;
              files.push(p);
            };
            const seenVideoKeys = new Set();
            for (const shot of shots) {
              const shotTag = String(shot.shotNo || files.length + 1).padStart(2, '0');
              const segDir = shotsDir ? join(shotsDir, `shot-${shotTag}`) : '';
              let localSegs = [];
              try {
                localSegs = readdirSync(segDir)
                  .filter((name) => /^seg-\d+\.mp4$/.test(name))
                  .sort()
                  .map((name) => join(segDir, name));
              } catch {
                localSegs = [];
              }
              if (localSegs.length) {
                coveredShots += 1;
                files.push(...localSegs);
                continue;
              }
              const localShot = join(shotsDir, `shot-${shotTag}.mp4`);
              if (existsSync(localShot)) {
                coveredShots += 1;
                files.push(localShot);
                continue;
              }
              const v = shot.outputs?.latestVideo;
              if (!v || v.status !== 'completed' || (!v.url && !v.userFileId)) {
                if (fillMissing) addPlaceholder(shot.shotNo);
                else missing += 1;
                continue;
              }
              let url = '';
              if (v.userFileId) {
                const d = await httpJson(`${base}/api/v1/user-files/download/${v.userFileId}`, { token });
                if (typeof d.json?.data === 'string') url = d.json.data;
              }
              if (!url && v.url) {
                const u = String(v.url);
                url = u.startsWith('http') ? u : `https://image.myreels.tv/${u.replace(/^\/+/, '')}`;
              }
              if (!url) {
                if (fillMissing) addPlaceholder(shot.shotNo);
                else missing += 1;
                continue;
              }
              const videoKey = v.userFileId ? `file:${v.userFileId}` : `url:${url}`;
              if (seenVideoKeys.has(videoKey)) {
                if (fillMissing) addPlaceholder(shot.shotNo);
                else missing += 1;
                continue;
              }
              seenVideoKeys.add(videoKey);
              const buf = await fetchBinary(url);
              if (!buf) {
                if (fillMissing) addPlaceholder(shot.shotNo);
                else missing += 1;
                continue;
              }
              const file = join(shotsDir || dir, `shot-${String(shot.shotNo || files.length + 1).padStart(2, '0')}.mp4`);
              writeFileSync(file, buf);
              coveredShots += 1;
              files.push(file);
            }
            for (const localShot of localShotFiles) {
              if (files.includes(localShot)) continue;
              files.push(localShot);
              coveredShots += 1;
            }

            for (const file of files) {
              if (!qcDurationOk(probeDurationSec(file))) degraded += 1;
              if (detectBlackFrameCount(file) > 1) degraded += 1;
              const frozen = detectFreezeSeconds(file);
              const duration = probeDurationSec(file);
              if (Number.isFinite(duration) && duration > 0 && frozen > duration * 0.8) degraded += 1;
            }
            partial = missing > 0 || placeholderCount > 0 || coveredShots < Math.max(shots.length, localShotFiles.length);

            if (!files.length) {
              blockers.push('没有可用的已完成分镜视频');
            } else {
              const listFile = join(dir, 'list.txt');
              writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
              if (!outPath) {
                outPath = layout?.renderPath || join(runsRoot(), '.renders', `${runId}.mp4`);
              }
              if (partial && !outPath.toLowerCase().endsWith('.partial.mp4')) {
                outPath = outPath.toLowerCase().endsWith('.mp4') ? `${outPath.slice(0, -4)}.partial.mp4` : `${outPath}.partial.mp4`;
              }
              mkdirSync(dirname(outPath), { recursive: true });
              const subPath = String(args?.subtitles || '').trim();
              const subtitleFilter = subPath
                ? buildSubtitleFilter(subPath, {
                  fontSize: Number(args?.subtitleFontSize) || 18,
                  marginV: Number(args?.subtitleMarginV) || 80,
                })
                : '';
              const normalize = args?.normalize !== false;
              try {
                if (normalize) {
                  const normalized = [];
                  const videoFilter = [
                    `scale=${cfg.render.width}:${cfg.render.height}:force_original_aspect_ratio=decrease`,
                    `pad=${cfg.render.width}:${cfg.render.height}:(ow-iw)/2:(oh-ih)/2`,
                    `fps=${cfg.render.fps}`,
                  ].join(',');
                  for (let index = 0; index < files.length; index += 1) {
                    const source = files[index];
                    const target = join(dir, `norm-${String(index).padStart(3, '0')}.mp4`);
                    const videoDuration = probeVideoDurationSec(source);
                    const clipArgs = ['-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-vf', videoFilter];
                    if (Number.isFinite(videoDuration) && videoDuration > 0) clipArgs.push('-t', String(videoDuration));
                    clipArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
                    clipArgs.push('-c:a', 'aac', '-ar', '48000', target);
                    runFfmpeg(clipArgs);
                    normalized.push(target);
                  }
                  const normalizedList = join(dir, 'normalized-list.txt');
                  writeFileSync(normalizedList, normalized.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
                  const joined = join(dir, 'joined.mp4');
                  runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', normalizedList, '-c', 'copy', joined]);
                  if (subtitleFilter) {
                    runFfmpeg(['-y', '-i', joined, '-vf', subtitleFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath]);
                  } else {
                    runFfmpeg(['-y', '-i', joined, '-c', 'copy', outPath]);
                  }
                } else if (subtitleFilter) {
                  runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', subtitleFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath]);
                } else {
                  runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);
                }
              } catch (error) {
                blockers.push(`渲染归一化失败：${String(error?.message || error)}`);
              }
              if (!existsSync(outPath)) {
                blockers.push('ffmpeg 未产出文件');
              } else {
                sizeMb = Number((statSync(outPath).size / 1048576).toFixed(1));
                const measured = probeDurationSec(outPath);
                durationSec = Number.isFinite(measured) ? Math.round(measured * 10) / 10 : 0;
                shortfallSec = Math.max(0, Math.round((plannedDurationSec - durationSec) * 10) / 10);
                if (state) {
                  writeRunState(runId, {
                    ...state,
                    stage: partial ? 'RENDER_PARTIAL' : 'RENDERED',
                    renderPath: outPath,
                    renderSizeMb: sizeMb,
                    renderDurationSec: durationSec,
                    episodePlannedSec: plannedDurationSec,
                    episodeShortfallSec: shortfallSec,
                    renderPartial: partial,
                    renderedAt: new Date().toISOString(),
                  });
                }
              }
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }

          return compactNulls({
            ok: blockers.length === 0,
            runId,
            path: outPath,
            shots: files.length,
            durationSec,
            plannedDurationSec,
            shortfallSec,
            sizeMb,
            missing,
            degraded,
            partial,
            blockers,
          });
        },
})
}
