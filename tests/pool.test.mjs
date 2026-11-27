import test from 'node:test';
import assert from 'node:assert/strict';
import { runRollingPool } from '../lib/story/pool.js';

const noSleep = async () => {};
const itemsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}` }));

test('滚动池始终保持并发上限并补位', async () => {
  const submitted = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const completionOrder = [];
  const running = [];

  const result = await runRollingPool({
    items: itemsOf(5),
    slots: 2,
    submit: async ([item]) => {
      const taskId = `t${item.id}`;
      submitted.push(taskId);
      running.push(taskId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return [{ taskId, itemId: item.id }];
    },
    poll: async (ids) => {
      const done = running.shift();
      inFlight -= 1;
      completionOrder.push(done);
      return new Map(ids.map((id) => [id, id === done ? 'completed' : 'running']));
    },
    intervalMs: 0,
    sleep: noSleep,
  });

  assert.equal(result.stop, '');
  assert.equal(result.settled.length, 5);
  assert.equal(result.submitted, 5);
  assert.equal(result.pending, 0);
  assert.equal(result.inflight.length, 0);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(completionOrder, ['ts1', 'ts2', 'ts3', 'ts4', 'ts5']);
  assert.deepEqual(submitted, ['ts1', 'ts2', 'ts3', 'ts4', 'ts5']);
});

test('完成一个后先补位，再进入下一轮 poll', async () => {
  const timeline = [];
  const running = [];
  await runRollingPool({
    items: itemsOf(3),
    slots: 2,
    submit: async ([item]) => {
      timeline.push(`submit:${item.id}`);
      const taskId = `t${item.id}`;
      running.push({ taskId, itemId: item.id });
      return [{ taskId, itemId: item.id }];
    },
    poll: async (ids) => {
      const next = running.shift();
      timeline.push(`poll:done=${next.itemId}`);
      return new Map(ids.map((id) => [id, id === next.taskId ? 'completed' : 'running']));
    },
    intervalMs: 0,
    sleep: noSleep,
  });
  assert.deepEqual(timeline, [
    'submit:s1', 'submit:s2',
    'poll:done=s1',
    'submit:s3',
    'poll:done=s2',
    'poll:done=s3',
  ]);
});

test('提交失败时停止补位，但已在跑的任务仍收尾', async () => {
  let calls = 0;
  const result = await runRollingPool({
    items: itemsOf(3),
    slots: 2,
    submit: async () => {
      calls += 1;
      return calls === 1 ? [{ taskId: 't1', itemId: 's1' }] : [];
    },
    poll: async (ids) => new Map(ids.map((id) => [id, 'completed'])),
    intervalMs: 0,
    sleep: noSleep,
  });
  assert.equal(result.stop, 'submit-failed');
  assert.equal(result.settled.length, 1);
  assert.equal(result.pending, 2);
  assert.equal(result.inflight.length, 0);
});

test('超时返回在跑与待提交数量', async () => {
  let tick = 0;
  const result = await runRollingPool({
    items: itemsOf(5),
    slots: 2,
    submit: async ([item]) => [{ taskId: `t${item.id}`, itemId: item.id }],
    poll: async (ids) => new Map(ids.map((id) => [id, 'processing'])),
    intervalMs: 10,
    now: () => (tick += 100),
    deadline: 150,
    sleep: noSleep,
  });
  assert.equal(result.stop, 'timeout');
  assert.equal(result.inflight.length, 2);
  assert.equal(result.pending, 3);
});

test('单个任务回写失败不影响整体', async () => {
  const running = ['t1', 't2'];
  const result = await runRollingPool({
    items: itemsOf(2),
    slots: 2,
    submit: async ([item]) => [{ taskId: `t${item.id.slice(1)}`, itemId: item.id }],
    poll: async (ids) => {
      const done = running.shift();
      return new Map(ids.map((id) => [id, id === done ? 'completed' : 'running']));
    },
    onSettled: async (done) => {
      if (done.taskId === 't1') throw new Error('write failed');
    },
    intervalMs: 0,
    sleep: noSleep,
  });
  assert.equal(result.settled.length, 2);
  assert.equal(result.stop, '');
});
