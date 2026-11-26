function normalize(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function quotes(text) {
  const source = String(text || '');
  const found = [];
  for (const re of [/[“"]([^”"]{1,})[”"]/g, /「([^」]{1,})」/g]) {
    for (const match of source.matchAll(re)) found.push(match[1].trim());
  }
  return found;
}

function dialogueLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[^：:\s]{1,16}(?:（[^）]*）)?\s*[：:]\s*.+/.test(line))
    .filter((line) => !/^(人物|场景|场景时段|出场角色|关键物品|画风|画面|运镜|动作与表演|对白\/旁白|声音|画面文字|结尾状态|分镜|第\d+集|【|△)/.test(line));
}

function spokenLines(text) {
  return dialogueLines(text)
    .map((line) => line.replace(/^[^：:\s]{1,16}(?:（[^）]*）)?\s*[：:]/, '').trim())
    .filter(Boolean);
}

function scenes(text) {
  return [...String(text || '').matchAll(/^\s*(【[^】]+】)\s*$/gm)].map((m) => m[1].trim());
}

function characters(text) {
  const names = new Set();
  const source = String(text || '');
  for (const match of source.matchAll(/(?:人物|出场角色)\s*[：:]\s*([^\n]+)/g)) {
    for (const name of match[1].split(/[、,，;；\/]/)) {
      const value = name.trim();
      if (value && value.length <= 16) names.add(value);
    }
  }
  return [...names];
}

function actions(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('△') || /^\*\*动作与表演\*\*/.test(line))
    .map((line) => line.replace(/^△/, '').replace(/^\*\*动作与表演\*\*\s*[：:]/, '').trim())
    .filter(Boolean);
}

function containsNormalized(haystack, needle) {
  const hay = normalize(haystack);
  const target = normalize(needle);
  return target.length > 0 && hay.includes(target);
}

export function compareScriptFidelity(original, optimized) {
  const src = String(original || '');
  const out = String(optimized || '');
  const issues = [];
  const srcQuotes = [...new Set(quotes(src).map(normalize).filter(Boolean))];
  const outQuotes = [...new Set(quotes(out).map(normalize).filter(Boolean))];
  const missingQuotes = srcQuotes.filter((quote) => !outQuotes.includes(quote));
  const addedQuotes = outQuotes.filter((quote) => !srcQuotes.includes(quote));
  for (const quote of missingQuotes) issues.push({ code: 'dialogue-missing', level: 'error', message: `台词丢失或被改写：${quote.slice(0, 40)}` });
  for (const quote of addedQuotes) issues.push({ code: 'dialogue-added', level: 'error', message: `新增了原剧本没有的台词：${quote.slice(0, 40)}` });

  const srcSpoken = [...new Set(spokenLines(src).map(normalize))];
  const outSpoken = [...new Set(spokenLines(out).map(normalize))];
  for (const line of srcSpoken) {
    if (!outSpoken.includes(line)) {
      issues.push({ code: 'dialogue-changed', level: 'error', message: `台词被改写/删除：${line.slice(0, 40)}` });
    }
  }
  for (const line of outSpoken) {
    if (!srcSpoken.includes(line)) {
      issues.push({ code: 'dialogue-added', level: 'error', message: `新增了原剧本没有的台词：${line.slice(0, 40)}` });
    }
  }

  const srcScenes = scenes(src);
  const outScenes = scenes(out);
  if (srcScenes.length) {
    const joinedOut = outScenes.join('\n');
    for (const scene of srcScenes) {
      if (!outScenes.includes(scene)) issues.push({ code: 'scene-missing', level: 'error', message: `场景标题丢失：${scene}` });
    }
    const filtered = outScenes.filter((scene) => srcScenes.includes(scene));
    if (filtered.join('\n') !== srcScenes.join('\n')) issues.push({ code: 'scene-order', level: 'error', message: '场景顺序与原剧本不一致' });
    if (!joinedOut.includes(srcScenes[0])) issues.push({ code: 'first-scene', level: 'warn', message: '第一场可能被移动' });
  }

  const srcChars = characters(src);
  const outChars = characters(out);
  for (const name of srcChars) {
    if (!outChars.includes(name) && !containsNormalized(out, name)) issues.push({ code: 'character-missing', level: 'error', message: `人物丢失：${name}` });
  }
  for (const name of outChars) {
    if (!srcChars.includes(name) && !containsNormalized(src, name)) issues.push({ code: 'character-added', level: 'warn', message: `新增了原剧本没有的人物：${name}` });
  }

  const srcActions = actions(src).flatMap((line) => line.split(/[。；;]/)).map(normalize).filter((line) => line.length >= 4);
  let missingActions = 0;
  for (const action of srcActions) {
    if (!out.includes(action) && !containsNormalized(out, action)) missingActions += 1;
  }
  if (missingActions) {
    issues.push({ code: 'actions-rewritten', level: 'warn', message: `${missingActions} 条动作描述未逐字保留（拆分/改写需人工确认不改变剧情）` });
  }

  return {
    ok: issues.every((issue) => issue.level !== 'error'),
    scenes: { original: srcScenes.length, optimized: outScenes.length },
    characters: { original: srcChars.length, optimized: outChars.length },
    dialogues: { original: srcQuotes.length, optimized: outQuotes.length },
    missingActions,
    issues,
  };
}
