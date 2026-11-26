const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(text) {
  const raw = String(text || '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of raw) {
    if (char === '百') {
      section += (digit || 1) * 100;
      digit = 0;
    } else if (char === '十') {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (char in CN_DIGITS) {
      digit = CN_DIGITS[char];
    }
  }
  total = section + digit;
  return total || 0;
}

const HEADER = /^\s*(?:第\s*([0-9一二三四五六七八九十百零两]+)\s*集|EP(?:ISODE)?\s*(\d+))\s*[:：、.\-—]?\s*(.*)$/im;

export function splitEpisodes(text) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(HEADER);
    if (match) {
      const no = Number(match[2]) || cnNumber(match[1]) || parts.length + 1;
      current = { episodeNo: no, title: String(match[3] || '').trim(), lines: [] };
      parts.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else {
      current = { episodeNo: 1, title: '', lines: [] };
      parts.push(current);
      current.lines.push(line);
    }
  }
  return parts
    .map((part) => {
      const body = part.lines.join('\n').trim();
      return {
        episodeNo: part.episodeNo,
        title: part.title,
        script: body,
        chars: body.length,
        preview: body.slice(0, 80),
      };
    })
    .filter((part) => part.script.length > 0);
}
