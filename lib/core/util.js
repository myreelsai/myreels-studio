export function summarizePoints(balancePayload) {
  const data = balancePayload?.data ?? balancePayload;
  if (!Array.isArray(data)) return null;
  let total = 0;
  for (const bucket of data) {
    total += Number(bucket?.base_points || 0) + Number(bucket?.bonus_points || 0);
  }
  return total;
}

export function parsePathList(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

export function parseEpisodeNo(text) {
  const m = String(text || '').match(/第\s*(\d+)\s*集/);
  return m ? Number(m[1]) : 1;
}

export function compactNulls(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (value[key] === null) delete value[key];
    }
  }
  return value;
}
