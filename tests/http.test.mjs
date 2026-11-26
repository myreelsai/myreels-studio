import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpJson } from '../lib/core/http.js';

test('httpJson: 5xx 自动重试后成功', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls < 3) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'busy' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const r = await httpJson(`http://127.0.0.1:${port}/x`);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test('httpJson: 网络错误最终返回 ERR + error', async () => {
  const r = await httpJson('http://127.0.0.1:1/never');
  assert.equal(r.status, 'ERR');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
