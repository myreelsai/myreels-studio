const RANGE = /(\d+)\s*-\s*(\d+)\s*秒\s*[：:]([\s\S]*?)(?=\d+\s*-\s*\d+\s*秒\s*[：:]|$)/g;
const QUOTED = /["“”]([^"“”]+)["“”]/g;

export function parseShotCues(prompt, { includeNarration = false } = {}) {
  const text = String(prompt || '');
  if (!text) return [];
  const blocks = [];
  let m;
  RANGE.lastIndex = 0;
  while ((m = RANGE.exec(text))) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    const body = m[3].trim();
    const quotes = [];
    let q;
    QUOTED.lastIndex = 0;
    while ((q = QUOTED.exec(body))) quotes.push(q[1].trim());
    blocks.push({ start, end, body, quotes });
  }
  const useQuotes = blocks.some((b) => b.quotes.length);
  const picked = useQuotes
    ? blocks.filter((b) => b.quotes.length).map((b) => ({ start: b.start, end: b.end, text: b.quotes.join(' ') }))
    : includeNarration || !useQuotes
      ? blocks.map((b) => ({ start: b.start, end: b.end, text: b.body }))
      : [];
  const source = picked.length ? picked : blocks.map((b) => ({ start: b.start, end: b.end, text: b.quotes.join(' ') || b.body }));
  if (!source.length) {
    const quotes = [];
    let q;
    QUOTED.lastIndex = 0;
    while ((q = QUOTED.exec(text))) quotes.push(q[1].trim());
    if (quotes.length) return [{ start: 0, end: 3, text: quotes.join(' ') }];
    return [];
  }
  const minStart = Math.min(...source.map((b) => b.start));
  return source.map((b) => ({ start: b.start - minStart, end: b.end - minStart, text: b.text }));
}

export function scaleCues(cues, videoDuration, scriptSpan) {
  const span = Number(scriptSpan) > 0 ? Number(scriptSpan) : Math.max(...cues.map((c) => c.end), 1);
  const scale = Number(videoDuration) > 0 ? Number(videoDuration) / span : 1;
  return cues.map((c) => ({ start: c.start * scale, end: c.end * scale, text: c.text }));
}

export function buildSrt(cues) {
  const fmt = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = s % 60;
    const ss = Math.floor(rest);
    const ms = Math.round((rest - ss) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return cues
    .filter((c) => c.text && c.end > c.start)
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
    .join('\n');
}
