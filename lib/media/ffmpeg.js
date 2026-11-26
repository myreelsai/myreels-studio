import { execFileSync, spawnSync } from 'node:child_process';

export function runFfmpeg(args, timeout = 180000) {
  execFileSync('ffmpeg', args, { timeout, stdio: 'pipe' });
}

export function detectBlackFrameCount(file) {
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackframe=amount=95:threshold=24', '-f', 'null', '-'], { encoding: 'utf8' });
    const err = String(r.stderr || '');
    return (err.match(/black_start/g) || []).length;
  } catch {
    return 0;
  }
}

export function parseFreezeSeconds(log) {
  const matches = String(log || '').match(/freeze_duration:\s*([\d.]+)/g) || [];
  return matches.reduce((sum, line) => sum + Number(line.split(':')[1]), 0);
}

export function detectFreezeSeconds(file) {
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'freezedetect=noise=-30dB:d=1', '-f', 'null', '-'], { encoding: 'utf8' });
    return parseFreezeSeconds(r.stderr);
  } catch {
    return 0;
  }
}

export function buildSubtitleFilter(srtPath, { fontSize = 18, marginV = 80 } = {}) {
  const normalized = String(srtPath).replace(/\\/g, '/').replace(/:/g, '\\:');
  return `subtitles='${normalized}':force_style='FontSize=${fontSize},MarginV=${marginV}'`;
}

export function probeDurationSec(file) {
  try {
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    return Number(String(d).trim());
  } catch {
    return NaN;
  }
}

/** Video stream duration; format duration can include an audio tail after apad. */
export function probeVideoDurationSec(file) {
  try {
    const d = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], { encoding: 'utf8' });
    const value = Number(String(d).trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* fall back to format duration */
  }
  return probeDurationSec(file);
}
