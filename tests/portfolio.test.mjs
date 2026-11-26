import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, groupRunsByProject } from '../lib/story/portfolio.js';

test('summarizeRun: 关键字段与目录', () => {
  const run = summarizeRun({
    runId: 'r1',
    projectId: 'p1',
    projectTitle: '剧A',
    episodeNo: 4,
    stage: 'RENDERED',
    spentPoints: 100,
    settings: { budgetPoints: 300 },
    renderPath: 'x.mp4',
  });
  assert.equal(run.projectTitle, '剧A');
  assert.equal(run.episodeNo, 4);
  assert.equal(run.budget, 300);
  assert.equal(run.rendered, true);
  assert.ok(run.episodeDir.includes('ep04'));
});

test('groupRunsByProject: 同项目多集聚合', () => {
  const runs = [
    summarizeRun({ runId: 'r1', projectId: 'p1', projectTitle: '剧A', episodeNo: 1, spentPoints: 100, settings: { budgetPoints: 300 }, lastAdvanceAt: '2026-01-02' }),
    summarizeRun({ runId: 'r2', projectId: 'p1', projectTitle: '剧A', episodeNo: 2, spentPoints: 50, settings: { budgetPoints: 300 }, lastAdvanceAt: '2026-01-03' }),
    summarizeRun({ runId: 'r3', projectId: 'p2', projectTitle: '剧B', episodeNo: 1, spentPoints: 10, settings: { budgetPoints: 300 }, lastAdvanceAt: '2026-01-01' }),
  ];
  const groups = groupRunsByProject(runs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].projectTitle, '剧A');
  assert.equal(groups[0].spent, 150);
  assert.equal(groups[0].runs.length, 2);
});
