export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * 滚动并发池：始终保持最多 slots 个任务在跑，任一任务进入终态就立刻补位。
 *
 * - submit(items) 提交一批（通常 1 个），返回 [{ taskId, itemId, ... }]；返回空数组表示停止提交
 * - poll(taskIds) 返回 Map<taskId, status>
 * - onSettled(done) 在任务进入终态后回调；回调抛错不会中断排队
 *
 * 返回 { settled, pending, inflight, stop, submitted }；stop 为 '' | 'submit-failed' | 'timeout'
 */
export async function runRollingPool({
  items,
  slots,
  submit,
  poll,
  onSettled = async () => {},
  intervalMs = 15000,
  deadline = 0,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const capacity = Math.max(1, Number(slots) || 1);
  const pending = Array.isArray(items) ? items.slice() : [];
  const inflight = new Map();
  const settled = [];
  let stop = '';
  let submitted = 0;

  while (true) {
    while (pending.length && inflight.size < capacity && !stop) {
      const item = pending[0];
      const entries = await Promise.resolve()
        .then(() => submit([item]))
        .catch(() => []);
      if (!Array.isArray(entries) || !entries.length) {
        stop = 'submit-failed';
        break;
      }
      pending.shift();
      for (const entry of entries) {
        const taskId = String(entry?.taskId || '');
        if (!taskId) continue;
        submitted += 1;
        inflight.set(taskId, { ...entry, taskId, itemId: entry?.itemId ?? item?.id });
      }
    }

    if (!inflight.size) break;
    if (deadline && now() >= deadline) {
      stop = stop || 'timeout';
      break;
    }

    const statuses = await Promise.resolve()
      .then(() => poll([...inflight.keys()]))
      .catch(() => new Map());
    let progressed = false;
    for (const [taskId, entry] of [...inflight]) {
      const status = String(statuses?.get?.(taskId) || '');
      if (!TERMINAL_STATUSES.has(status)) continue;
      inflight.delete(taskId);
      progressed = true;
      const done = { ...entry, taskId, status };
      settled.push(done);
      try {
        await onSettled(done);
      } catch {
        /* 单个回写失败不影响其它任务继续补位 */
      }
    }

    if (!progressed) {
      if (deadline && now() + intervalMs > deadline) {
        stop = stop || 'timeout';
        break;
      }
      await sleep(intervalMs);
    }
  }

  return { settled, pending: pending.length, inflight: [...inflight.values()], stop, submitted };
}
