const BEAT = /^(\d+(?:\.\d+)?)\s*[—\-~至]\s*(\d+(?:\.\d+)?)\s*秒[：:]\s*([\s\S]*)$/;

function fmt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function shiftToLocal(beat, offset) {
  return `${fmt(beat.start - offset)}—${fmt(beat.end - offset)}秒：${beat.text}`;
}

export function splitShotPrompt(prompt, splitSec = 15) {
  const source = String(prompt || '');
  const split = Number(splitSec) || 15;
  const lines = source.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*##?\s*分镜\s*\d+\s*[｜|]/.test(line));
  const fields = [];
  const beats = [];
  let suffix = [];
  let inBeats = false;
  for (const line of lines) {
    const beat = line.match(BEAT);
    if (beat) {
      inBeats = true;
      beats.push({ start: Number(beat[1]), end: Number(beat[2]), text: String(beat[3] || '').trim() });
      continue;
    }
    if (!inBeats && /^\s*\*\*[^*]+\*\*\s*[：:]/.test(line)) {
      fields.push(line);
      continue;
    }
    if (!inBeats && line.trim() && !/^\s*##?\s*分镜/.test(line)) fields.push(line);
    if (inBeats) suffix.push(line);
  }
  const warnings = [];
  if (!beats.length) {
    warnings.push('没有识别到秒级时间切点，无法按时间拆分');
    return { first: source, second: '', split, warnings };
  }
  const boundary = beats.findIndex((beat) => beat.start >= split);
  const cut = boundary === -1 ? beats.length : boundary;
  const firstBeats = beats.slice(0, cut);
  const secondBeats = beats.slice(cut);
  if (!firstBeats.length || !secondBeats.length) warnings.push('切点落在所有时间切点之外，需手动调整 splitSec');
  const firstHeader = `## 分镜${headerIndex >= 0 ? (lines[headerIndex].match(/分镜\s*(\d+)/) || [])[1] || 'x' : 'x'}｜00:00—00:${fmt(split)}（${fmt(split)} 秒）`;
  const offset = secondBeats.length ? secondBeats[0].start : split;
  const secondDuration = beats[beats.length - 1].end - offset;
  const secondHeader = `## 分镜｜00:00—00:${fmt(secondDuration)}（${fmt(secondDuration)} 秒）承接`;
  const first = [
    firstHeader,
    ...fields,
    ...firstBeats.map((beat) => `${fmt(beat.start)}—${fmt(Math.min(beat.end, split))}秒：${beat.text}`),
    '**结尾状态**：本段停在中点动作，下一段从该状态继续。',
  ].join('\n');
  const second = [
    secondHeader,
    '**承接**：承接上一段最后一帧的动作、站位、服装与光线，不重新起幅。',
    ...fields,
    ...secondBeats.map((beat) => shiftToLocal(beat, offset)),
    ...suffix,
  ].join('\n');
  return { first, second, split, warnings };
}
