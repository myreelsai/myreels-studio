import { httpJson } from '../core/http.js';

export async function fetchStyleCandidates(base, token, pageSize = 8) {
  if (!token) return [];
  const paths = ['/api/v1/story-workbench/wiki-prompts/query', '/story-workbench/wiki-prompts/query'];
  for (const path of paths) {
    const r = await httpJson(base + path, {
      method: 'POST',
      token,
      body: { scope: 'public', taxonomyGroup: 'comic_prompt', taxonomySlug: 'art-style', pageSize },
    });
    if (r.status !== 200) continue;
    const data = r.json?.data ?? {};
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.pages) ? data.pages : Array.isArray(data) ? data : [];
    return items
      .map((x) => ({ pageId: String(x.pageId ?? x.id ?? ''), title: String(x.translation?.title || x.title || ''), summary: String(x.translation?.summary || x.summary || '') }))
      .filter((x) => x.pageId)
      .slice(0, pageSize);
  }
  return [];
}

export async function ensureGroup(base, token, name, storyProjectId) {
  const body = { name };
  if (storyProjectId) body.storyProjectId = storyProjectId;
  const r = await httpJson(`${base}/api/v1/canvas/project-groups`, { method: 'POST', token, body });
  return { status: r.status, id: Number(r.json?.data?.id ?? r.json?.id ?? 0), json: r.json };
}

export async function ensureStoryProjectForGroup(base, token, groupId, title) {
  const r = await httpJson(`${base}/api/v1/story-projects`, {
    method: 'POST',
    token,
    body: { ensureForProjectGroup: true, projectGroupId: groupId, title, projectType: 'drama', metadata: { source: 'dsh-agent' } },
  });
  const data = r.json?.data || r.json || {};
  return { status: r.status, projectId: String(data.storyProjectId || data.project?.id || data.id || ''), json: r.json };
}

export async function putProjectMetadata(base, token, projectId, metadata) {
  return httpJson(`${base}/api/v1/story-projects/${projectId}`, { method: 'PUT', token, body: { metadata } });
}

export async function ensureCanvas(base, token, projectId, groupId, name) {
  const p = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
  const meta = p.json?.data?.metadata && typeof p.json.data.metadata === 'object' ? p.json.data.metadata : {};
  if (Number(meta.canvasProjectId) > 0) return Number(meta.canvasProjectId);

  const canvasName = String(name || p.json?.data?.title || 'MyReels 画布');
  const c = await httpJson(`${base}/api/v1/canvas/projects`, {
    method: 'POST',
    token,
    body: {
      name: canvasName,
      canvas_data: { version: 1, elements: [], zoom: 25, panOffset: { x: 0, y: 0 }, canvasName, generators: [], videoGenerators: [], audioGenerators: [] },
      contentRevision: 1,
      content_revision: 1,
      allow_empty_overwrite: true,
      allowEmptyOverwrite: true,
    },
  });
  const canvasProjectId = Number(c.json?.data?.id || 0);
  if (!canvasProjectId) return 0;
  if (groupId) {
    await httpJson(`${base}/api/v1/canvas/project-group-bindings`, {
      method: 'POST',
      token,
      body: { canvasProjectGroupId: Number(groupId), canvasProjectId, bindingRole: 'project_canvas' },
    });
  }
  await putProjectMetadata(base, token, projectId, {
    ...meta,
    canvasProjectId,
    ...(groupId ? { canvasProjectGroupId: Number(groupId), projectGroupId: Number(groupId) } : {}),
  });
  return canvasProjectId;
}

export async function resolveUserFileIdByUrl(base, token, url, taskId) {
  const baseName = String(url || '').split('/').pop();
  if (!baseName) return '';
  const probes = taskId
    ? [`${base}/api/v1/user-files?taskId=${encodeURIComponent(taskId)}&limit=20`, `${base}/api/v1/user-files?limit=1000`]
    : [`${base}/api/v1/user-files?limit=1000`];
  for (const url2 of probes) {
    const r = await httpJson(url2, { token });
    const list = Array.isArray(r.json?.data) ? r.json.data : r.json?.data?.items || [];
    const hit = list.find((x) => String(x.r2_object_key || '').endsWith(baseName));
    if (hit?.id) return String(hit.id);
  }
  return '';
}

export async function resolveUserFileIdByTask(base, token, taskId, resultUrl) {
  const baseName = String(resultUrl || '').split('?')[0].split('/').pop();
  const probes = [`${base}/api/v1/user-files?taskId=${encodeURIComponent(taskId)}&limit=20`, `${base}/api/v1/user-files?limit=1000`];
  for (const url of probes) {
    const r = await httpJson(url, { token });
    const list = Array.isArray(r.json?.data) ? r.json.data : r.json?.data?.items || [];
    const hit = list.find((x) => baseName && String(x.r2_object_key || '').endsWith(baseName));
    if (hit?.id) return String(hit.id);
  }
  return '';
}

export async function syncGeneratedResult(base, token, body) {
  return httpJson(`${base}/api/v1/story-workbench/generated-results/sync`, { method: 'POST', token, body });
}

export async function createEpisode(base, token, projectId, episodeNo) {
  const r = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes`, {
    method: 'POST',
    token,
    body: { episodeNo, title: `第${episodeNo}集` },
  });
  return { status: r.status, id: String(r.json?.data?.id || ''), json: r.json };
}

export async function createScript(base, token, episodeId, text) {
  const r = await httpJson(`${base}/api/v1/story-episodes/${episodeId}/scripts`, { method: 'POST', token, body: { rawText: text } });
  return { status: r.status, id: String(r.json?.data?.id || ''), json: r.json };
}

export function buildAnalyzeRequest({ text, stylePrompt, mode, episodeNo, analysis }) {
  const episode = Number(episodeNo);
  if (!Number.isInteger(episode) || episode <= 0) {
    throw new Error('剧本分析必须指定单个集号（episodeNo > 0），不允许分析集范围');
  }
  const body = {
    prompt_resource_slug: 'story-analyzer-analysis',
    script_text: text,
    style_prompt: stylePrompt,
    script_processing_mode: mode,
    // 单集分析：范围始终是 [N, N]，批量时由上层并行提交多个单集任务。
    finalParameters: { episode_range: [episode, episode] },
  };
  if (mode === 'director_storyboard') body.is_director_script = true;
  if (analysis && typeof analysis === 'object') {
    if (Number.isFinite(Number(analysis.shotDurationSeconds))) body.shot_duration_seconds = Number(analysis.shotDurationSeconds);
    if (Number.isFinite(Number(analysis.maxShotsPerSegment))) body.max_shots_per_segment = Number(analysis.maxShotsPerSegment);
    if (Number.isFinite(Number(analysis.speechRate))) body.speech_rate = Number(analysis.speechRate);
    if (analysis.isDirectorScript !== undefined) body.is_director_script = analysis.isDirectorScript !== false;
    if (analysis.modelKey) body.analysis_model_key = String(analysis.modelKey);
    if (analysis.llmGroup) body.llm_group = String(analysis.llmGroup);
    if (analysis.outputLanguage) body.output_language = String(analysis.outputLanguage);
  }
  return body;
}

export async function submitAnalyze(base, token, scriptId, { text, stylePrompt, mode, episodeNo, analysis }) {
  const body = buildAnalyzeRequest({ text, stylePrompt, mode, episodeNo, analysis });
  const r = await httpJson(`${base}/api/v1/story-scripts/${scriptId}/analyze`, { method: 'POST', token, body });
  const data = r.json?.data || {};
  return { status: r.status, taskId: String(data.task?.id || ''), statusText: String(data.progress || data.run?.status || ''), json: r.json };
}

export async function fetchAnalysisModels(base, token) {
  const r = await httpJson(`${base}/api/v1/story-analysis-models`, { token });
  const data = r.json?.data;
  return Array.isArray(data) ? data : [];
}

export async function fetchAnalyzerTool(base, token) {
  const r = await httpJson(`${base}/api/v1/tools/story-analyzer-analysis`, { token });
  return r.json?.data || null;
}

export async function findImageTool(base, token, modelName) {
  const t = await httpJson(`${base}/api/v1/tools?limit=300`, { token });
  const items = t.json?.data?.items || [];
  return items.find((x) => String(x.modelName) === modelName) || null;
}

export async function findToolBySlug(base, token, slug) {
  const t = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
  const items = t.json?.data?.items || [];
  return items.find((x) => String(x.slug) === String(slug || '')) || null;
}

export async function submitVariantGenerate(base, token, variantId, body) {
  const r = await httpJson(`${base}/api/v1/story-asset-variants/${variantId}/generate`, { method: 'POST', token, body });
  const data = r.json?.data || {};
  return { status: r.status, taskId: String(data.task?.id || data.variant?.taskId || ''), json: r.json };
}

export async function waitTaskStatuses(base, token, taskIds, { intervalMs = 15000, maxRounds = 60 } = {}) {
  const ids = [...new Set((taskIds || []).map((id) => String(id || '')).filter(Boolean))];
  const results = new Map(ids.map((id) => [id, 'pending']));
  if (!ids.length) return results;
  for (let round = 0; round < maxRounds; round += 1) {
    const responses = await Promise.all(ids.map((id) => (
      httpJson(`${base}/api/v1/tasks/${id}`, { token }).catch(() => null)
    )));
    let done = true;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const s = String(responses[index]?.json?.data?.status || '');
      if (s) results.set(id, s);
      if (s !== 'completed' && s !== 'failed') done = false;
    }
    if (done) break;
    if (round < maxRounds - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return results;
}

export async function lookupRunStatus(base, token, state, options = {}) {  const out = { stage: 'UNKNOWN', analysisStatus: '', progress: 0, episodeStatus: '', assetsCount: 0, assetsWithImage: 0, assetsGeneratable: 0, shotsCount: 0, videoCount: 0 };
  if (state.taskId) {
    const t = await httpJson(`${base}/api/v1/tasks/${state.taskId}`, { token });
    const d = t.json?.data || {};
    out.analysisStatus = String(d.status || '');
    out.progress = typeof d.progress === 'number' ? d.progress : 0;
    if (out.analysisStatus === 'completed') out.stage = 'ANALYSIS_DONE';
    else if (out.analysisStatus === 'failed') out.stage = 'ANALYSIS_FAILED';
    else if (out.analysisStatus === 'processing' || out.analysisStatus === 'running') out.stage = 'ANALYSIS_RUNNING';
    else out.stage = 'ANALYSIS_QUEUED';
  }
  if (state.projectId) {
    const eps = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/episodes?page=1&limit=200`, { token });
    const items = eps.json?.data?.items || [];
    const ep = items.find((x) => Number(x.episodeNo) === Number(state.episodeNo)) || items.find((x) => x.analysisRunId) || items[0] || null;
    if (ep) {
      out.episodeStatus = String(ep.scriptAnalysisStatus || '');
      if (out.stage === 'ANALYSIS_QUEUED' && out.episodeStatus === 'completed') out.stage = 'ANALYSIS_DONE';
      const assets = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
      out.assetsCount = (assets.json?.data?.items || []).length;
      let withImg = 0;
      let withVariants = 0;
      const assetItems = assets.json?.data?.items || [];
      if (options.skipVariantScan) {
        withImg = assetItems.filter((asset) => Boolean(asset.referenceImageUrl || asset.referenceUserFileId)).length;
        withVariants = assetItems.length;
      } else {
        for (let i = 0; i < assetItems.length; i += 60) {
          const chunk = assetItems.slice(i, i + 60);
          const results = await Promise.all(chunk.map(async (asset) => {
            const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
            return vs.json?.data?.items || [];
          }));
          for (const list of results) {
            if (list.length) withVariants += 1;
            if (list.some((x) => x.imageUrl)) withImg += 1;
          }
        }
      }
      out.assetsWithImage = withImg;
      out.assetsGeneratable = withVariants;
      const shots = await httpJson(`${base}/api/v1/story-episodes/${ep.id}/shots`, { token });
      const shotItems = shots.json?.data?.items || [];
      out.shotsCount = shotItems.length;
      out.videoCount = shotItems.filter((s) => {
        const v = s.outputs?.latestVideo;
        return v?.status === 'completed' && Boolean(v?.url || v?.userFileId);
      }).length;
    }
  }
  if (state.renderPath) out.stage = state.renderPartial ? 'RENDER_PARTIAL' : 'RENDERED';
  return out;
}

