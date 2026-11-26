import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { buildRefIndex, resolveRefTags } from '../story/refs.js';
import { variantHasImage } from '../story/image-state.js';
import { layoutOfState } from '../storage/layout.js';

const preview = (text, limit) => String(text || '').replace(/\s+/g, ' ').slice(0, limit);

export default function createTool(config) {
  return defineTool({
    name: 'myreels_snapshot',
    description: '只读上下文快照（免费）：项目/集/资产+提示词/分镜+时长+视频/参考图问题/预算/目录，供 Agent 决策下一步；不生成、不扣点。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      promptLimit: { type: 'number', description: '每个提示词预览字符数（默认 300）' },
      limit: { type: 'number', description: '最多返回多少个资产变体（默认 40）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          stage: { type: 'string' },
          project: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string' }, title: { type: 'string' } },
          },
          episode: {
            type: 'object',
            additionalProperties: false,
            properties: { no: { type: 'number' }, status: { type: 'string' } },
          },
          budget: {
            type: 'object',
            additionalProperties: false,
            properties: {
              budget: { type: 'number' },
              spent: { type: 'number' },
              remaining: { type: 'number' },
            },
          },
          paths: {
            type: 'object',
            additionalProperties: false,
            properties: {
              episodeDir: { type: 'string' },
              assetsDir: { type: 'string' },
              shotsDir: { type: 'string' },
              renderPath: { type: 'string' },
              subtitlePath: { type: 'string' },
              reportPath: { type: 'string' },
            },
          },
          assets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                assetType: { type: 'string' },
                assetName: { type: 'string' },
                variantName: { type: 'string' },
                variantId: { type: 'string' },
                hasImage: { type: 'boolean' },
                confirmed: { type: 'boolean' },
                promptPreview: { type: 'string' },
              },
            },
          },
          shots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                shotNo: { type: 'number' },
                durationSeconds: { type: 'number' },
                videoStatus: { type: 'string' },
                refOk: { type: 'boolean' },
                refIssueCount: { type: 'number' },
                promptPreview: { type: 'string' },
              },
            },
          },
          refIssues: { type: 'array', items: { type: 'string' } },
          hints: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [];
        lines.push(`snapshot ${value.runId}`);
        lines.push(`- 项目: ${value.project?.title || value.project?.id || '?'} / 集 ${value.episode?.no ?? '?'}（${value.episode?.status || '?'}） stage=${value.stage || '?'}`);
        lines.push(`- 预算: 已花 ${value.budget?.spent ?? 0} / 预算 ${value.budget?.budget ?? 0}（剩余 ${value.budget?.remaining ?? 0}）`);
        lines.push(`- 资产 ${value.assets.length} 个变体（有图 ${value.assets.filter((a) => a.hasImage).length}） / 分镜 ${value.shots.length}（有视频 ${value.shots.filter((s) => s.videoStatus === 'completed').length}）`);
        if (value.refIssues.length) {
          lines.push(`- 参考图问题 ${value.refIssues.length}:`);
          for (const issue of value.refIssues.slice(0, 8)) lines.push(`    · ${issue}`);
        }
        if (value.hints.length) {
          lines.push('- 建议（供决策，不自动执行）:');
          for (const hint of value.hints) lines.push(`    · ${hint}`);
        }
        lines.push(`- 目录: ${value.paths?.episodeDir || ''}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const promptLimit = Math.max(60, Number(args?.promptLimit || 300));
      const limit = Math.max(1, Number(args?.limit || 40));
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      const layout = layoutOfState(state);
      let project = { id: String(state?.projectId || ''), title: String(state?.projectTitle || '') };
      let episode = { no: Number(state?.episodeNo) || 0, status: '' };
      const assets = [];
      const shots = [];
      const refIssues = [];
      const hints = [];

      if (state && token && !blockers.length) {
        const proj = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
        if (proj.status === 200) project = { id: state.projectId, title: String(proj.json?.data?.title || project.title) };
        const eps = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/episodes`, { token });
        const ep = (eps.json?.data?.items || []).find((x) => Number(x.episodeNo) === Number(state.episodeNo));
        if (ep) episode = { no: Number(ep.episodeNo) || 0, status: String(ep.scriptAnalysisStatus || ep.status || '') };

        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assetItems = assetsRes.json?.data?.items || [];
        const variantsByAsset = new Map();
        for (const asset of assetItems) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          const variants = vs.json?.data?.items || [];
          variantsByAsset.set(asset.id, variants);
          for (const variant of variants) {
            if (assets.length >= limit) continue;
            assets.push({
              assetType: String(asset.assetType || ''),
              assetName: String(asset.name || ''),
              variantName: String(variant.name || ''),
              variantId: String(variant.id || ''),
              hasImage: variantHasImage(variant),
              confirmed: variant.metadata?.confirmed === true,
              promptPreview: preview(variant.prompt || variant.description, promptLimit),
            });
          }
        }

        const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const shotItems = shotsRes.json?.data?.items || [];
        const index = buildRefIndex(assetItems, variantsByAsset);
        for (const shot of shotItems) {
          const resolved = resolveRefTags(shot.prompt || shot.description, index);
          const issues = resolved.filter((tag) => tag.status !== 'ok');
          for (const issue of issues) refIssues.push(`分镜 ${shot.shotNo}: (@${issue.variant} | ${issue.asset}) — ${issue.status}`);
          shots.push({
            shotNo: Number(shot.shotNo) || 0,
            durationSeconds: Number(shot.durationSeconds) || 0,
            videoStatus: String(shot.outputs?.latestVideo?.status || ''),
            refOk: issues.length === 0,
            refIssueCount: issues.length,
            promptPreview: preview(shot.prompt || shot.description, promptLimit),
          });
        }
      }

      const budget = Number(state?.settings?.budgetPoints || 0);
      const spent = Number(state?.spentPoints || 0);
      const missingImages = assets.filter((a) => !a.hasImage).length;
      const shotsNoVideo = shots.filter((s) => s.videoStatus !== 'completed').length;
      if (missingImages) hints.push(`资产还有 ${missingImages} 个变体缺图；可先补图（myreels_run_advance assets / myreels_assetfix）`);
      if (refIssues.length) hints.push(`参考图有 ${refIssues.length} 处问题；补图后重跑 myreels_refcheck 验证`);
      if (shotsNoVideo) hints.push(`${shotsNoVideo} 个分镜还没有视频；可用 myreels_run_advance shots（自动按 durationSeconds 选时长档）`);
      const plannedSec = shots.reduce((sum, shot) => sum + (Number(shot.durationSeconds) || 0), 0);
      if (plannedSec) hints.push(`计划集时长 ${plannedSec}s（按分镜时长汇总），当前成片 ${Number(state?.renderDurationSec) || '未渲染'}s；是否补段由 Agent 决定`);
      if (shots.length && !shotsNoVideo) hints.push('分镜视频已齐；可 myreels_subtitle → myreels_render → myreels_report');
      if (budget > 0 && spent >= budget) hints.push(`预算已用满（${spent}/${budget}），生成前需调整 budgetPoints`);
      else hints.push(`剩余预算 ${Math.max(0, budget - spent)} 点（图片 ${cfg.unitCost.image}/张，视频 ${cfg.unitCost.video}/条）`);

      return compactNulls({
        ok: blockers.length === 0,
        runId,
        stage: String(state?.stage || ''),
        project,
        episode,
        budget: { budget, spent, remaining: Math.max(0, budget - spent) },
        paths: layout
          ? {
              episodeDir: layout.episodeDir,
              assetsDir: layout.assetsDir,
              shotsDir: layout.shotsDir,
              renderPath: layout.renderPath,
              subtitlePath: layout.subtitlePath,
              reportPath: layout.reportPath,
            }
          : undefined,
        assets,
        shots,
        refIssues,
        hints,
        blockers,
      });
    },
  });
}
