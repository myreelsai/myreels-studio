import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { buildRefIndex } from '../story/refs.js';
import { shotPreflight, variantPreflight, summarizePreflight } from '../story/preflight.js';
import { loadRules, findRuleForCode } from '../rules/index.js';
import { auditShotContract } from '../story/contract.js';
import { findVideoTool } from '../story/video-model.js';
import { findImageTool } from '../story/image-model.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_preflight',
    description: '生成前检查（免费）：参考图是否齐全/数量超限、提示词是否超模型上限、时长是否需分段、变体文本/图状态；只报事实，不生成。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      shotNo: { type: 'number', description: '只查某个分镜（可空=全部分镜）' },
      checkVariants: { type: 'boolean', description: '是否检查资产变体（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          ready: { type: 'boolean' },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              errors: { type: 'number' },
              warnings: { type: 'number' },
              infos: { type: 'number' },
              ready: { type: 'boolean' },
            },
          },
          models: {
            type: 'object',
            additionalProperties: false,
            properties: {
              image: { type: 'string' },
              video: { type: 'string' },
              videoMaxDuration: { type: 'number' },
              videoPromptMaxLength: { type: 'number' },
              videoMaxImages: { type: 'number' },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string' },
                shotNo: { type: 'number' },
                assetName: { type: 'string' },
                variantName: { type: 'string' },
                promptLength: { type: 'number' },
                refs: { type: 'number' },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      code: { type: 'string' },
                      ruleId: { type: 'string' },
                      level: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
          rulesLoaded: { type: 'number' },
          manualRules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                level: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render(args, value) {
        const lines = [`preflight ${value.runId}: ${value.ready ? '可生成' : '有阻塞'}（error ${value.summary.errors} / warn ${value.summary.warnings} / info ${value.summary.infos}）`];
        lines.push(`- 规则: ${value.rulesLoaded} 条（人工检查 ${value.manualRules.length} 项，生成后由 Agent 看）`);
        lines.push(`- 模型: 图 ${value.models?.image || '?'} / 视频 ${value.models?.video || '?'} / 单段上限 ${value.models?.videoMaxDuration || '?'}s / 提示词上限 ${value.models?.videoPromptMaxLength || '?'} 字`);
        for (const item of value.results) {
          const errors = item.issues.filter((i) => i.level === 'error');
          if (!errors.length) continue;
          const label = item.scope === 'shot' ? `分镜 ${item.shotNo}` : `${item.assetName}/${item.variantName}`;
          for (const issue of errors) lines.push(`  · ${label}: ${issue.message}`);
        }
        if (!value.ready) lines.push('  → 按上述事实修复（精简提示词/补参考图/换更长时长模型）；默认不拆段，只有明确要求时才拆');
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const blockers = [];
      const state = readRunState(runId);
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

      let imageSchema = null;
      let videoSchema = null;
      let imageName = String(state?.settings?.imageModel || cfg.imageModel || '');
      let videoName = String(state?.settings?.videoModelSlug || cfg.videoModelSlug || '');
      const results = [];

      if (state && token && !blockers.length) {
        const toolsRes = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
        const tools = toolsRes.json?.data?.items || [];
        const projectRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
        const projectMeta = projectRes.json?.data?.metadata && typeof projectRes.json.data.metadata === 'object'
          ? projectRes.json.data.metadata
          : {};
        const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const shotItems = shotsRes.json?.data?.items || [];
        const imageSlug = String(state?.settings?.imageModelSlug || cfg.imageModelSlug || '');
        const configuredImageTool = findImageTool(tools, projectMeta);
        const imageTool = configuredImageTool
          || tools.find((t) => String(t.slug) === imageSlug)
          || tools.find((t) => String(t.modelName) === imageName)
          || null;
        const effectiveImageSlug = String(imageTool?.slug || imageSlug || '');
        const requestedVideoSlug = String(state?.settings?.videoModelSlug || cfg.videoModelSlug || '');
        const configuredVideoTool = findVideoTool(tools, projectMeta);
        const effectiveVideoSlug = String(configuredVideoTool?.slug || requestedVideoSlug || '');
        const videoTool = configuredVideoTool
          || tools.find((t) => String(t.slug) === effectiveVideoSlug)
          || tools.find((t) => String(t.slug) === requestedVideoSlug)
          || null;
        imageSchema = imageTool?.userInputSchema || null;
        videoSchema = videoTool?.userInputSchema || null;
        imageName = String(imageTool?.name || effectiveImageSlug || imageName);
        videoName = String(videoTool?.name || effectiveVideoSlug || videoName);
        if (!imageTool) blockers.push(`图片模型不存在：${effectiveImageSlug || imageName}`);
        if (!videoTool) blockers.push(`视频模型不存在：${effectiveVideoSlug}`);

        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assets = assetsRes.json?.data?.items || [];
        const variantsByAsset = new Map();
        for (const asset of assets) {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          variantsByAsset.set(asset.id, vs.json?.data?.items || []);
        }
        const index = buildRefIndex(assets, variantsByAsset);

        const shotNo = Number(args?.shotNo || 0);
        for (const shot of shotItems) {
          if (shotNo && Number(shot.shotNo) !== shotNo) continue;
          const base = shotPreflight(shot, index, videoSchema);
          const audit = auditShotContract(shot, { maxRefs: 4 });
          results.push({ scope: 'shot', ...base, issues: [...base.issues, ...audit.issues] });
        }

        if (args?.checkVariants !== false) {
          for (const asset of assets) {
            for (const variant of variantsByAsset.get(asset.id) || []) {
              results.push({ scope: 'variant', ...variantPreflight(asset, variant, imageSchema) });
            }
          }
        }
      }

      const { rules, manual } = loadRules();
      for (const item of results) {
        for (const issue of item.issues || []) {
          const rule = findRuleForCode(issue.code, rules);
          if (!rule) continue;
          issue.ruleId = rule.id;
          issue.level = rule.level;
        }
      }
      const summary = summarizePreflight(results);
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        ready: summary.ready && blockers.length === 0,
        summary,
        rulesLoaded: rules.length,
        manualRules: manual.map((rule) => ({ id: rule.id, scope: rule.scope, level: rule.level, message: rule.message })),
        models: {
          image: imageName,
          video: videoName,
          videoMaxDuration: Number((videoSchema?.duration?.options || []).map((o) => Number(o.value)).filter((n) => n > 0).reduce((a, b) => Math.max(a, b), 0)) || 0,
          videoPromptMaxLength: Number(videoSchema?.prompt?.maxLength) || 0,
          videoMaxImages: Number(videoSchema?.images?.maxFiles) || 0,
        },
        results,
        blockers,
      });
    },
  });
}
