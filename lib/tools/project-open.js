import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { resolveOwner, ownerFields, localRunVisible } from '../core/owner.js';
import { authStatus } from '../core/auth.js';
import { stateDir, writeRunState } from '../core/state.js';
import { layoutOfState } from '../storage/layout.js';
import { compactNulls } from '../core/util.js';
import { putProjectMetadata } from '../story/client.js';

function visibleLocalProjectIds() {
  const session = authStatus();
  const ids = new Set();
  try {
    for (const file of readdirSync(stateDir())) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      try {
        const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
        if (state?.projectId && localRunVisible(state, session)) ids.add(String(state.projectId));
      } catch {
        /* skip broken state */
      }
    }
  } catch {
    /* state dir missing */
  }
  return ids;
}

const shortId = (id) => String(id || '').slice(0, 8);
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function projectGroupsAsProjects(base, token, limit) {
  const r = await httpJson(
    `${base}/api/v1/canvas/project-groups?page=1&pageSize=${limit}&limit=${limit}&status=active&cacheBust=${Date.now()}`,
    { token },
  );
  if (r.status !== 200) {
    return { projects: [], error: `读取故事台项目列表失败（HTTP ${r.status}）` };
  }
  const payload = r.json?.data;
  const items = Array.isArray(payload)
    ? payload
    : (payload?.items || payload?.groups || []);
  const seen = new Set();
  const projects = [];
  for (const group of items) {
    const id = String(group?.storyProjectId || group?.story_project_id || '').trim();
    if (!FULL_UUID.test(id) || seen.has(id)) continue;
    seen.add(id);
    projects.push({
      id,
      title: String(group?.name || group?.title || '未命名'),
      groupId: Number(group?.id) || 0,
    });
  }
  return { projects, error: '' };
}

function findLocalRun(projectId, episodeNo, owner) {
  const ownerKey = String(owner?.ownerKey || '');
  const legacySubaccount = owner?.ownerType === 'subaccount';
  let best = null;
  let bestAt = '';
  try {
    for (const file of readdirSync(stateDir())) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      try {
        const state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
        if (!state?.runId) continue;
        if (String(state.projectId || '') !== String(projectId || '')) continue;
        if (Number(state.episodeNo) !== Number(episodeNo)) continue;
        if (ownerKey && state.ownerKey && String(state.ownerKey) !== ownerKey) continue;
        if (ownerKey && !state.ownerKey && legacySubaccount) continue;
        if (!ownerKey && owner?.userId && state.ownerUserId && String(state.ownerUserId) !== String(owner.userId)) continue;
        const at = String(state.attachedAt || state.createdAt || '');
        if (!best || at.localeCompare(bestAt) > 0) {
          best = state;
          bestAt = at;
        }
      } catch {
        /* skip broken state */
      }
    }
  } catch {
    /* state dir missing */
  }
  return best;
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_project_open',
    description:
      '列出或接入当前登录用户在 WebUI 故事台已有的项目：list=true 按故事台的 canvas/project-groups 聚合列出项目；给 projectId 或 projectTitle（如「双向伪装」）即接入该集，生成 runId，之后 snapshot / asset_audit / run_advance / render / report / preview 照常可用。同项目同集已接入过默认复用，不重复建 run。',
    parameters: {
      projectId: { type: 'string', description: '故事项目 UUID（也支持 list 返回的唯一短 ID 前缀；与 projectTitle 二选一）' },
      projectTitle: { type: 'string', description: '剧名（精确或包含匹配，如「双向伪装」）' },
      episodeNo: { type: 'number', description: '集号（空=自动选最后一集已完成分析的，否则最后一集）' },
      list: { type: 'boolean', description: '只列项目，不接入' },
      keyword: { type: 'string', description: 'list 时的剧名过滤词' },
      limit: { type: 'number', description: 'list 返回条数上限（默认 100，最大 100）' },
      reuse: { type: 'boolean', description: '同项目同集已有本地 run 时复用（默认 true）' },
      markManaged: { type: 'boolean', description: '是否写入 harnessManaged 标记（仅写自定义 metadata，不覆盖 source；默认 false）' },
      budgetPoints: { type: 'number', description: '本次预算（空=项目 metadata 的 runBudgetPoints）' },
      assetReview: { type: 'string', description: 'manual / auto / off（空=项目设置）' },
      videoModelSlug: { type: 'string', description: '视频模型 slug（空=项目设置）' },
      imageModelSlug: { type: 'string', description: '图片模型 slug（空=项目设置）' },
      aspect: { type: 'string', description: '画幅 9:16 / 16:9 / 1:1（空=项目设置）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          runId: { type: 'string' },
          projectId: { type: 'string' },
          projectTitle: { type: 'string' },
          episodeNo: { type: 'number' },
          episodeId: { type: 'string' },
          scriptId: { type: 'string' },
          groupId: { type: 'number' },
          stage: { type: 'string' },
          managed: { type: 'boolean' },
          statePath: { type: 'string' },
          episodeDir: { type: 'string' },
          renderPath: { type: 'string' },
          episodes: { type: 'array', items: { type: 'string' } },
          projects: { type: 'array', items: { type: 'string' } },
          candidates: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`project_open ${value.mode || 'attach'}: ${value.ok ? 'ok' : '失败'}`];
        if (value.projects?.length) {
          lines.push(`- 项目 ${value.projects.length} 个：`);
          for (const p of value.projects) lines.push(`    · ${p}`);
        }
        if (value.projectTitle) lines.push(`- 项目: ${value.projectTitle}（${value.projectId}）`);
        if (value.groupId) lines.push(`- 画布组: ${value.groupId}`);
        if (value.episodeNo) lines.push(`- 当前集: EP${value.episodeNo}（${value.episodeId || '-'}）`);
        if (value.episodes?.length) lines.push(`- 全部集: ${value.episodes.join(' / ')}`);
        if (value.runId) lines.push(`- runId: ${value.runId}${value.mode === 'reuse' ? '（复用已有 run）' : ''}`);
        if (value.statePath) lines.push(`- state: ${value.statePath}`);
        if (value.episodeDir) lines.push(`- 产物目录: ${value.episodeDir}`);
        if (value.renderPath) lines.push(`- 成片将输出: ${value.renderPath}`);
        if (value.candidates?.length) {
          lines.push('- 候选项目（用 projectId 指定）：');
          for (const c of value.candidates) lines.push(`    · ${c}`);
        }
        for (const w of value.warnings || []) lines.push(`  ! ${w}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const blockers = [];
      const warnings = [];
      let managed = false;
      const candidates = [];
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      const owner = token ? await resolveOwner(base, token) : { userId: '', username: '' };

      const wantList = args?.list === true;
      const projectIdArg = String(args?.projectId || '').trim();
      const titleArg = String(args?.projectTitle || '').trim();
      const episodeNoArg = Number(args?.episodeNo || 0);

      let projects = [];
      if (!blockers.length && (wantList || !FULL_UUID.test(projectIdArg))) {
        const limit = Math.max(1, Math.min(100, Number(args?.limit || 100)));
        const result = await projectGroupsAsProjects(base, token, limit);
        if (result.error) blockers.push(result.error);
        else projects = result.projects;
      }

      if (!blockers.length && wantList) {
        const kw = String(args?.keyword || '').trim().toLowerCase();
        const filtered = kw
          ? projects.filter((x) => String(x.title || '').toLowerCase().includes(kw))
          : projects;
        return compactNulls({
          ok: true,
          mode: 'list',
          projects: filtered.map((x) => `${shortId(x.id)} | ${String(x.title || '未命名')}`),
          warnings,
          blockers,
        });
      }

      let projectId = projectIdArg;
      if (!blockers.length && projectId && !FULL_UUID.test(projectId)) {
        const prefix = projectId.toLowerCase();
        if (prefix.length < 4) {
          blockers.push('projectId 前缀至少需要 4 位；也可以直接用 projectTitle');
        } else {
          const matches = projects.filter((project) => String(project.id).toLowerCase().startsWith(prefix));
          if (matches.length === 1) {
            projectId = matches[0].id;
          } else if (matches.length > 1) {
            blockers.push(`projectId 前缀匹配到多个故事台项目：${matches.slice(0, 5).map((project) => `${shortId(project.id)} ${project.title || ''}`).join(' / ')}；请用完整 UUID 或 projectTitle`);
          } else {
            blockers.push(`找不到故事台 projectId 前缀：${prefix}；请先用 list=true 重新列出项目，或使用剧名`);
          }
        }
      }
      if (!blockers.length && !projectId) {
        if (!titleArg) {
          blockers.push('需要 projectId 或 projectTitle（可先 list=true 列项目）');
        } else {
          const needle = titleArg.toLowerCase();
          const exact = projects.filter((x) => String(x.title || '').trim() === titleArg);
          const partial = projects.filter((x) => String(x.title || '').toLowerCase().includes(needle));
          const pool = exact.length ? exact : partial;
          if (pool.length === 1) projectId = String(pool[0].id || '');
          else if (pool.length > 1) {
            blockers.push(`剧名「${titleArg}」匹配到 ${pool.length} 个项目，请用 projectId 指定`);
            for (const p of pool) candidates.push(`${shortId(p.id)} | ${String(p.title || '')}`);
          } else {
            blockers.push(`没找到剧名包含「${titleArg}」的项目（当前列出 ${projects.length} 个）`);
          }
        }
      }

      let project = null;
      if (!blockers.length && projectId) {
        const pr = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
        if (pr.status !== 200) blockers.push(`项目不可读（HTTP ${pr.status}）：${projectId}`);
        else {
          project = pr.json?.data || {};
          const projectMeta = project.metadata && typeof project.metadata === 'object' ? project.metadata : {};
          const localIds = visibleLocalProjectIds();
          const backendScoped = String(owner.tokenProvider || '').toLowerCase() === 'subaccount';
          const visible = backendScoped
            || localIds.has(String(projectId))
            || (projectMeta.harnessOwnerKey && String(projectMeta.harnessOwnerKey) === String(owner.ownerKey || ''))
            || String(owner.ownerType || '') !== 'subaccount';
          if (!visible) blockers.push('当前子账号无权接入该项目');
        }
      }

      let episodes = [];
      if (!blockers.length && project) {
        const er = await httpJson(`${base}/api/v1/story-projects/${projectId}/episodes?page=1&limit=200`, { token });
        if (er.status !== 200) blockers.push(`读取集列表失败（HTTP ${er.status}）`);
        episodes = (er.json?.data?.items || [])
          .map((x) => ({
            id: String(x.id || ''),
            no: Number(x.episodeNo) || 0,
            status: String(x.scriptAnalysisStatus || x.status || ''),
          }))
          .sort((a, b) => a.no - b.no);
        if (!episodes.length) blockers.push('该项目还没有剧集（先在 WebUI 里建集并提交分析）');
      }

      let episode = null;
      if (!blockers.length && episodes.length) {
        if (episodeNoArg) {
          episode = episodes.find((x) => x.no === episodeNoArg) || null;
          if (!episode) blockers.push(`项目里没有第 ${episodeNoArg} 集（现有 ${episodes.map((x) => x.no).join('/')}）`);
        } else {
          const done = episodes.filter((x) => x.status === 'completed');
          episode = done.length ? done[done.length - 1] : episodes[episodes.length - 1];
          if (!done.length) warnings.push('没有已完成分析的集，接入后状态可能不完整');
        }
      }

      const episodeLines = episodes.map((x) => `EP${x.no}:${x.status || '?'}`);
      const meta = project?.metadata && typeof project.metadata === 'object' ? project.metadata : {};
      const projectTitle = String(project?.title || titleArg || projectId || '');
      const reuse = args?.reuse !== false;
      if (args?.markManaged === true && !blockers.length && projectId) {
        const managedMetadata = {
          ...meta,
          harnessManaged: true,
          harnessManagedBy: 'myreels-studio',
          harnessManagedAt: new Date().toISOString(),
          harnessOwnerKey: String(owner.ownerKey || ''),
          harnessOwnerLabel: String(owner.ownerLabel || owner.username || ''),
          harnessOwnerSubaccountId: owner.ownerSubaccountId ?? null,
        };
        const put = await putProjectMetadata(base, token, projectId, managedMetadata);
        if (put.status !== 200) {
          warnings.push(`写入 harnessManaged 标记失败（HTTP ${put.status}），本次仍会创建本地 run`);
        } else {
          managed = true;
        }
      }

      if (!blockers.length && episode && reuse) {
        const existing = findLocalRun(projectId, episode.no, owner);
        if (existing) {
          const layout = layoutOfState(existing);
          return compactNulls({
            ok: true,
            mode: 'reuse',
            runId: existing.runId,
            projectId,
            projectTitle,
            episodeNo: episode.no,
            episodeId: episode.id || String(existing.episodeId || ''),
            scriptId: String(existing.scriptId || ''),
            groupId: Number(existing.groupId || 0),
            stage: String(existing.stage || ''),
            managed,
            statePath: '',
            episodeDir: layout?.episodeDir || '',
            renderPath: layout?.renderPath || '',
            episodes: episodeLines,
            warnings,
            blockers,
          });
        }
      }

      let scriptId = '';
      if (!blockers.length && episode?.id) {
        try {
          const d = await httpJson(`${base}/api/v1/story-episodes/${episode.id}`, { token });
          if (d.status === 200) {
            const dd = d.json?.data || {};
            scriptId = String(dd.scriptId || dd.script_id || dd.script?.id || dd.latestScriptId || '');
          }
        } catch {
          /* 尽力而为：拿不到 scriptId 不影响后续资产/分镜/渲染 */
        }
      }

      const settings = {
        aspect: String(args?.aspect || meta.defaultVideoRatio || '9:16'),
        styleText: String(meta.defaultStyleWikiPrompt?.promptTemplate || ''),
        stylePageId: String((Array.isArray(meta.defaultStyleWikiPromptIds) ? meta.defaultStyleWikiPromptIds[0] : '') || ''),
        budgetPoints: Number(args?.budgetPoints || meta.runBudgetPoints || 0),
        assetReview: String(args?.assetReview || meta.assetReview || 'manual'),
        scriptProcessingMode: String(meta.scriptProcessingMode || meta.script_processing_mode || 'script_standard'),
        imageModel: String(cfg.imageModel || ''),
        imageModelSlug: String(args?.imageModelSlug || meta.imageModelSlug || cfg.imageModelSlug),
        videoModelSlug: String(args?.videoModelSlug || meta.defaultMultiVideoModel || meta.defaultVideoModel || meta.videoModelSlug || cfg.videoModelSlug),
      };
      const groupId = Number(meta.projectGroupId || meta.canvasProjectGroupId || 0);
      const canvasProjectId = Number(meta.canvasProjectId || 0);

      let runId = '';
      let statePath = '';
      if (!blockers.length && episode) {
        runId = randomUUID();
        statePath = writeRunState(runId, {
          runId,
          projectId,
          projectTitle,
          groupId,
          canvasProjectId,
          episodeId: episode.id,
          scriptId,
          episodeNo: episode.no,
          episodeEnd: episode.no,
          scriptText: '',
          taskId: '',
          stage: 'ATTACHED',
          attachedFrom: 'webui',
          attachedAt: new Date().toISOString(),
          settings,
          ...ownerFields(owner),
          createdAt: new Date().toISOString(),
        });
      }

      const layout = runId ? layoutOfState({ projectId, projectTitle, episodeNo: episode?.no, runId }) : null;
      return compactNulls({
        ok: blockers.length === 0,
        mode: 'attach',
        runId,
        projectId,
        projectTitle,
        episodeNo: Number(episode?.no) || 0,
        episodeId: String(episode?.id || ''),
        scriptId,
        groupId,
        stage: 'ATTACHED',
        managed,
        statePath,
        episodeDir: layout?.episodeDir || '',
        renderPath: layout?.renderPath || '',
        episodes: episodeLines,
        candidates,
        warnings,
        blockers,
      });
    },
  });
}
