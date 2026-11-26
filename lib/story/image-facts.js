import { execFileSync } from 'node:child_process';

export function probeImage(file) {
  const out = { imageWidth: 0, imageHeight: 0, aspect: '', meanLuminance: 0 };
  try {
    const text = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
    const [w, h] = text.split(',').map((n) => Number(n));
    out.imageWidth = w || 0;
    out.imageHeight = h || 0;
    if (w && h) out.aspect = `${w}:${h}`;
  } catch {
    /* probe optional */
  }
  try {
    const raw = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      { encoding: 'buffer', timeout: 8000 }
    );
    if (raw && raw.length) out.meanLuminance = raw[0];
  } catch {
    /* luminance optional */
  }
  return out;
}

export function timeWords(text) {
  const src = String(text || '');
  const words = [];
  for (const [word, pattern] of [
    ['夜', /夜|深夜|夜晚|晚间/],
    ['日', /日间|白天|清晨|午后|上午|下午/],
    ['黄昏', /黄昏|傍晚|日落|夕阳/],
    ['室内', /室内|内景|车内|房间|客厅|走廊/],
    ['室外', /室外|外景|户外|红毯|广场|街/],
  ]) {
    if (pattern.test(src)) words.push(word);
  }
  return words;
}

export function layoutWords(text) {
  const src = String(text || '');
  const words = [];
  for (const [word, pattern] of [
    ['四视图', /四视图/],
    ['三视图', /三视图/],
    ['多视图', /多视图|多角度|多视角/],
    ['九宫格', /九宫格|九宫/],
    ['单人', /单人|半身|全身像|肖像/],
  ]) {
    if (pattern.test(src)) words.push(word);
  }
  return words;
}
