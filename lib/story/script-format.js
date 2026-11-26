const DIRECTOR_FIELDS = ['出场角色', '场景', '画面', '运镜', '动作与表演', '对白/旁白', '声音', '结尾状态'];
const FORBIDDEN_NORMAL = ['冷开场', '钩子', '全剧终', '横屏', '竖屏', '镜头切到', '推近', '拉远'];

function timeToSec(text) {
  const match = String(text || '').match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function count(text, re) {
  return (String(text || '').match(re) || []).length;
}

export function classifyScript(text) {
  const source = String(text || '');
  const directorBlocks = count(source, /^\s*(?:##?\s*)?分镜\s*\d+\s*[｜|]/gm);
  const canonicalBlocks = count(source, /^\s*##?\s*分镜\s*\d+\s*[｜|]\s*\d{1,2}:\d{2}\s*[—\-~至]/gm);
  const timecodes = count(source, /\d{1,2}:\d{2}\s*[—\-~至]\s*\d{1,2}:\d{2}/g);
  const looseTimecodes = count(source, /\d+(?:\.\d+)?\s*[—\-~至]\s*\d+(?:\.\d+)?\s*秒/g);
  const fields = DIRECTOR_FIELDS.filter((field) => new RegExp(`(?:\\*\\*)?${field}(?:\\*\\*)?\\s*[：:]`).test(source)).length;
  const sceneHeaders = count(source, /^\s*【[^】]+】\s*$/gm);
  const personLines = count(source, /^\s*人物\s*[：:]/gm);
  const actionLines = count(source, /^\s*△/gm);
  const dialogueLines = count(source, /^\s*[^\s：:]{1,16}(?:（[^）]*）)?\s*[：:]/gm);
  const episodeHeader = /^\s*第\s*[0-9一二三四五六七八九十百]+\s*集/m.test(source);

  const evidence = [];
  if (directorBlocks) evidence.push(`导演本标记：${directorBlocks} 个「分镜N」块`);
  if (canonicalBlocks) evidence.push(`规范分镜标题：${canonicalBlocks} 个（带 mm:ss 时间码）`);
  if (timecodes) evidence.push(`时间码：${timecodes} 处`);
  if (looseTimecodes) evidence.push(`秒级时间切点：${looseTimecodes} 处`);
  if (fields) evidence.push(`导演字段：${fields}/8`);
  if (sceneHeaders) evidence.push(`场标题：${sceneHeaders} 个【...】`);
  if (personLines) evidence.push(`人物行：${personLines} 行`);
  if (actionLines) evidence.push(`动作行：${actionLines} 行 △`);
  if (dialogueLines) evidence.push(`台词行：${dialogueLines} 行`);

  let format = 'unknown';
  let confidence = 0.3;
  if (canonicalBlocks > 0 && (timecodes > 0 || fields >= 3)) {
    format = 'director';
    confidence = Math.min(0.98, 0.7 + Math.min(0.15, canonicalBlocks / 50) + Math.min(0.1, fields / 40));
  } else if (directorBlocks > 0) {
    format = 'director-draft';
    confidence = 0.72;
    evidence.push('有分镜编号但缺少规范标题/时间码/字段，需先转成 MyReels 导演本');
  } else if (sceneHeaders > 0 || personLines > 0 || actionLines > 0) {
    format = sceneHeaders > 0 && (personLines > 0 || actionLines > 0) ? 'normal' : 'hybrid';
    confidence = format === 'normal' ? 0.85 : 0.6;
  } else if (episodeHeader && (dialogueLines > 3 || actionLines > 3)) {
    format = 'normal';
    confidence = 0.62;
  } else {
    evidence.push('缺少分镜/场次/人物/动作结构，可能是纯小说或未格式化文本');
  }

  return {
    format,
    confidence,
    recommendedMode: format === 'director' ? 'director_storyboard' : format === 'director-draft' ? 'convert-to-director' : 'script_standard',
    evidence,
    stats: {
      directorBlocks,
      timecodes: timecodes + looseTimecodes,
      fields,
      sceneHeaders,
      personLines,
      actionLines,
      dialogueLines,
      chars: source.length,
    },
  };
}

export function validateDirectorDraft(text, { maxDurationSec = 30 } = {}) {
  const source = String(text || '');
  const issues = [];
  const cap = Number(maxDurationSec) || 30;
  const blocks = [];
  const headerRe = /^\s*(?:##?\s*)?分镜\s*(\d+)\s*[｜|]\s*([^\n]*)$/gm;
  let match;
  while ((match = headerRe.exec(source))) blocks.push({ no: Number(match[1]), index: match.index });
  if (!blocks.length) issues.push({ code: 'no-director-blocks', level: 'error', message: '没有识别到「分镜N」结构' });
  blocks.forEach((block, i) => {
    if (block.no !== i + 1) issues.push({ code: 'non-contiguous', level: 'error', message: `分镜编号不连续：第 ${i + 1} 个块是分镜${block.no}` });
    const body = source.slice(block.index, blocks[i + 1]?.index ?? source.length);
    if (!/场景\s*[：:]/.test(body)) issues.push({ code: 'missing-scene', level: 'warn', message: `分镜${block.no} 缺少场景字段` });
    if (!/出场角色\s*[：:]/.test(body)) issues.push({ code: 'missing-characters', level: 'warn', message: `分镜${block.no} 缺少出场角色` });
    const ranges = [...body.matchAll(/(\d+(?:\.\d+)?)\s*[—\-~至]\s*(\d+(?:\.\d+)?)\s*秒/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
    if (!ranges.length) {
      issues.push({ code: 'missing-time-segments', level: 'warn', message: `分镜${block.no} 没有秒级时间切点` });
    } else {
      ranges.forEach((range, j) => {
        if (range.end <= range.start) issues.push({ code: 'bad-segment', level: 'error', message: `分镜${block.no} 第 ${j + 1} 段时间范围无效` });
        if (range.end > cap) issues.push({ code: 'over-cap', level: 'error', message: `分镜${block.no} 第 ${j + 1} 段结束 ${range.end}s > 档位 ${cap}s` });
        if (j > 0 && range.start !== ranges[j - 1].end) issues.push({ code: 'segment-gap', level: 'warn', message: `分镜${block.no} 第 ${j + 1} 段起点 ${range.start}s 与上段终点 ${ranges[j - 1].end}s 不连续` });
      });
    }
    if (/\d{1,2}:\d{2}\s*[—\-~至]\s*\d{1,2}:\d{2}/.test(body)) {
      issues.push({ code: 'format-timecode', level: 'warn', message: `分镜${block.no} 用了 mm:ss 时间码，规范标题需「分镜N｜00:00—00:30（30 秒）」` });
    }
  });
  return {
    mode: 'director-draft',
    cap,
    blocks: blocks.length,
    issues,
    ok: issues.every((issue) => issue.level !== 'error'),
  };
}

export function validateDirectorScript(text, { maxDurationSec = 30 } = {}) {
  const source = String(text || '');
  const issues = [];
  const cap = Number(maxDurationSec) || 30;
  const blocks = [];
  const headerRe = /^\s*##?\s*分镜\s*(\d+)\s*[｜|]\s*(\d{1,2}:\d{2})\s*[—\-~至]\s*(\d{1,2}:\d{2})\s*[（(]?\s*(\d+(?:\.\d+)?)\s*秒?\s*[）)]?\s*(.*)$/gm;
  let match;
  while ((match = headerRe.exec(source))) {
    blocks.push({
      no: Number(match[1]),
      start: timeToSec(match[2]),
      end: timeToSec(match[3]),
      duration: Number(match[4]),
      index: match.index,
    });
  }
  if (!blocks.length) issues.push({ code: 'no-director-blocks', level: 'error', message: '没有识别到「## 分镜N｜时间—时间（X 秒）」结构' });
  const seen = new Set();
  let prevEnd = 0;
  blocks.forEach((block, i) => {
    if (seen.has(block.no)) issues.push({ code: 'duplicate-block', level: 'error', message: `分镜${block.no} 编号重复` });
    seen.add(block.no);
    if (block.no !== i + 1) issues.push({ code: 'non-contiguous', level: 'error', message: `分镜编号不连续：第 ${i + 1} 个块是分镜${block.no}` });
    if (block.end <= block.start) issues.push({ code: 'bad-time-range', level: 'error', message: `分镜${block.no} 结束时间必须大于开始时间` });
    if (block.duration !== block.end - block.start) issues.push({ code: 'duration-mismatch', level: 'warn', message: `分镜${block.no} 标注 ${block.duration}s 与时间码差 ${block.end - block.start}s 不一致` });
    if (block.duration > cap) issues.push({ code: 'over-cap', level: 'error', message: `分镜${block.no} ${block.duration}s > 档位 ${cap}s` });
    if (i > 0 && block.start !== prevEnd) issues.push({ code: 'timeline-gap', level: 'warn', message: `分镜${block.no} 起点 ${block.start}s 与上一块终点 ${prevEnd}s 不连续` });
    prevEnd = block.end;
    const body = source.slice(block.index, blocks[i + 1]?.index ?? source.length);
    for (const field of ['出场角色', '场景', '画面', '动作与表演', '对白/旁白', '结尾状态']) {
      if (!new RegExp(`\\*\\*${field}\\*\\*`).test(body)) issues.push({ code: 'missing-field', level: 'warn', message: `分镜${block.no} 缺少字段「${field}」` });
    }
  });
  if (/^\s*##?\s*(?:S\d+|Shot\s*\d+|镜头\s*\d+)/m.test(source)) {
    issues.push({ code: 'invalid-top-unit', level: 'error', message: '顶层单位必须用「分镜N」，不能用 S01/Shot/镜头N' });
  }
  return {
    mode: 'director',
    cap,
    blocks: blocks.length,
    totalSeconds: prevEnd,
    issues,
    ok: issues.every((issue) => issue.level !== 'error'),
  };
}

export function validateNormalScript(text) {
  const source = String(text || '');
  const lines = source.split(/\r?\n/);
  const issues = [];
  const nonEmpty = lines.filter((line) => line.trim());
  const first = (nonEmpty[0] || '').trim();
  if (!/^第\s*[0-9一二三四五六七八九十百]+\s*集$/.test(first)) issues.push({ code: 'bad-first-line', level: 'error', message: '第一行必须是「第N集」，不能带集名' });
  if (/^\s*#/m.test(source)) issues.push({ code: 'markdown-heading', level: 'error', message: '普通本不允许 # / Markdown 标题' });
  if (/^\s*分镜\s*\d+/m.test(source)) issues.push({ code: 'has-storyboard', level: 'error', message: '普通本不允许出现「分镜N」' });
  if (/\d{1,2}:\d{2}\s*[—\-~至]\s*\d{1,2}:\d{2}/.test(source)) issues.push({ code: 'has-timecode', level: 'error', message: '普通本不允许时间码' });
  if (/^\s*▲/m.test(source)) issues.push({ code: 'has-triangle', level: 'error', message: '▲ 段落必须改为 △ 动作行' });

  const scenes = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^【[^】]+】$/.test(trimmed)) scenes.push({ line: index, title: trimmed });
  });
  if (!scenes.length) issues.push({ code: 'no-scene', level: 'error', message: '没有识别到【场景】标题' });
  for (const scene of scenes) {
    const next = lines.slice(scene.line + 1).find((line) => line.trim());
    if (!/^人物\s*[：:]/.test(String(next || '').trim())) {
      issues.push({ code: 'missing-people', level: 'warn', message: `${scene.title} 下一行不是「人物：...」` });
    }
  }
  for (const tag of FORBIDDEN_NORMAL) {
    if (new RegExp(tag).test(source)) issues.push({ code: 'forbidden-tag', level: 'warn', message: `出现应删除的生产标签/镜头指令：${tag}` });
  }
  if (/^△[^\n]*[：:][^\n]*$/m.test(source)) issues.push({ code: 'mixed-action-dialogue', level: 'warn', message: '动作行里混有台词，应拆成 △动作 与 角色：台词' });
  if (/^\s*(?:手机屏幕|匾额|纸张|文件|屏幕)[^\n]*[：:]/m.test(source)) issues.push({ code: 'screen-text-as-dialogue', level: 'warn', message: '屏幕/纸张文字应写在 △ 行，不能写成台词' });

  return {
    mode: 'normal',
    scenes: scenes.length,
    issues,
    ok: issues.every((issue) => issue.level !== 'error'),
  };
}
