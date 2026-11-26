import { layoutOfState } from '../storage/layout.js';

export function summarizeRun(state) {
  const layout = layoutOfState(state);
  return {
    runId: String(state.runId || ''),
    projectId: String(state.projectId || ''),
    projectTitle: String(state.projectTitle || state.projectId || ''),
    episodeNo: Number(state.episodeNo) || 0,
    stage: String(state.stage || ''),
    spent: Number(state.spentPoints || 0),
    budget: Number(state.settings?.budgetPoints || 0),
    updatedAt: String(state.lastAdvanceAt || state.createdAt || ''),
    rendered: Boolean(state.renderPath),
    episodeDir: layout?.episodeDir || '',
  };
}

export function groupRunsByProject(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.projectId || run.projectTitle;
    if (!groups.has(key)) {
      groups.set(key, {
        projectId: run.projectId,
        projectTitle: run.projectTitle,
        runs: [],
        spent: 0,
        budget: 0,
        latestUpdatedAt: '',
      });
    }
    const group = groups.get(key);
    group.runs.push(run);
    group.spent += run.spent;
    group.budget = Math.max(group.budget, run.budget);
    if (run.updatedAt > group.latestUpdatedAt) group.latestUpdatedAt = run.updatedAt;
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: group.runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}
