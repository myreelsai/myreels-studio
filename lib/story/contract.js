const CONTINUITY_HINTS = ['同一件', '同一张脸', '不变', '无眼镜', '不戴眼镜', '固定'];

function splitBeats(prompt) {
  const source = String(prompt || '');
  const matches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*[—\-~至]\s*(\d+(?:\.\d+)?)\s*秒[：:]/g)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      text: source.slice(start, end).replace(/^[\s。；;]+/, '').trim(),
    };
  });
}

export function auditShotContract(shot, { maxRefs = 4, maxBeatsPer15s = 6, checkDialogueDuration = true } = {}) {
  const prompt = String(shot?.prompt || shot?.description || '');
  const duration = Number(shot?.durationSeconds) || 0;
  const issues = [];
  const beats = splitBeats(prompt);
  const refs = [...prompt.matchAll(/\(@([^|)]+)\|([^)]+)\)/g)].length;

  if (refs > maxRefs) {
    issues.push({ code: 'refs-too-many', level: 'warn', message: `参考图 ${refs} 张 > 建议 ${maxRefs} 张，容易串角色` });
  }
  if (duration && beats.length) {
    const allowed = Math.max(3, Math.ceil((duration / 15) * maxBeatsPer15s));
    if (beats.length > allowed) {
      issues.push({ code: 'beats-dense', level: 'warn', message: `${duration}s 内 ${beats.length} 个时间切点，建议 ≤${allowed}；动作会被压缩` });
    }
  }
  const manipulation = /披|穿|脱|递|拿|接|举|握|签|翻/;
  for (const beat of beats) {
    if (!manipulation.test(beat.text)) continue;
    const hasHand = /手|指尖|掌|臂|肩/.test(beat.text);
    if (!hasHand) {
      issues.push({ code: 'prop-no-blocking', level: 'warn', message: '动作缺手部/肩部/持有者描述，道具容易瞬移' });
    }
    if (/披|穿|脱/.test(beat.text) && !/[→先再]/.test(beat.text)) {
      issues.push({ code: 'action-not-decomposed', level: 'warn', message: '穿衣/披衣/脱衣未分解为连续步骤，容易瞬移' });
    }
  }
  if (/眼镜/.test(prompt) && !/无眼镜|不戴眼镜|没有眼镜/.test(prompt)) {
    issues.push({ code: 'glasses-risk', level: 'warn', message: '提示词出现「眼镜」，模型可能给角色加眼镜' });
  }
  if (!/(无字幕|无内嵌|无任何文字|不要字幕|无文字)/.test(prompt)) {
    issues.push({ code: 'subtitle-unlocked', level: 'warn', message: '未声明“无字幕/无文字”，模型可能烧字幕' });
  }
  if (!/(不要|禁止|不得|避免|无)[^。\n]{2,}/.test(prompt)) {
    issues.push({ code: 'no-negative-constraints', level: 'warn', message: '缺少负面约束（畸形手、穿模、字幕、水印等）' });
  }
  if (!CONTINUITY_HINTS.some((hint) => prompt.includes(hint))) {
    issues.push({ code: 'no-continuity-lock', level: 'warn', message: '缺少连续性锁定（同一张脸/同一件外套/无眼镜）' });
  }
  const dialogues = [...prompt.matchAll(/[“"]([^”"]{2,})[”"]|\{([^}]{2,})\}/g)].map((m) => m[1] || m[2]);
  if (checkDialogueDuration && duration > 0 && dialogues.length) {
    const spokenChars = dialogues.reduce((sum, line) => sum + (line.match(/[\u4e00-\u9fff]/g) || []).length, 0);
    const neededSec = spokenChars / 4.5;
    if (spokenChars > 0 && neededSec > duration + 0.3) {
      issues.push({ code: 'dialogue-too-long', level: 'warn', message: `台词约 ${spokenChars} 字，按 4.5 字/秒至少需 ${neededSec.toFixed(1)}s，当前 ${duration}s；建议压缩台词或调整分镜时长` });
    }
  }
  if (dialogues.length && !/(无字幕|无内嵌|无任何文字)/.test(prompt)) {
    issues.push({ code: 'dialogue-text-risk', level: 'warn', message: '含引号台词且未禁字幕，模型很可能把台词烧进画面' });
  }
  return {
    shotNo: Number(shot?.shotNo) || 0,
    duration,
    refs,
    beats: beats.length,
    issues,
    ready: issues.every((issue) => issue.level !== 'error'),
  };
}
