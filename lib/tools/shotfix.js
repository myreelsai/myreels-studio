import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';

const hash = (value) => String(value || '').length;

export default function createTool(config) {
  return defineTool({
    name: 'myreels_shotfix',
    description: '编辑分镜提示词：PUT /story-shots/:shotId 改 shot.prompt；可选同步改写该镜所有 shot-variant 的 prompt/videoMotionPrompt。改完可用 myreels_run_advance(shots, force) 重生成。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      shotNo: { type: 'number', description: '分镜号（默认 1）' },
      shotId: { type: 'string', description: '分镜 id（可空，优先于 shotNo）' },
      promptPatch: { type: 'string', description: '要写进 shot.prompt 的补丁' },
      promptMode: { type: 'string', description: 'append（默认）/ replace' },
      syncVariants: { type: 'boolean', description: '是否同步改写该镜所有 shot-variant（默认 true）' },
      variantPatch: { type: 'string', description: '写进 shot-variant 的补丁（可空=用同一个 promptPatch）' },
      subtitlePolicy: { type: 'string', description: '字幕策略（如 none / off）' },
      negativePrompt: { type: 'string', description: '负向提示词，写入 shot-variant' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          shotId: { type: 'string' },
          shotNo: { type: 'number' },
          shotPromptUpdated: { type: 'boolean' },
          variantsUpdated: { type: 'number' },
          promptLength: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`shotfix 分镜 ${value.shotNo || value.shotId}: shot.prompt ${value.shotPromptUpdated ? '已更新' : '未改'}（${value.promptLength} 字），variant 更新 ${value.variantsUpdated}`];
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

      let shot = null;
      let shotPromptUpdated = false;
      let variantsUpdated = 0;
      let promptLength = 0;

      if (state && token && !blockers.length) {
        const res = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
        const shots = res.json?.data?.items || [];
        const wantedId = String(args?.shotId || '');
        const wantedNo = Number(args?.shotNo || 1);
        shot = wantedId ? shots.find((s) => s.id === wantedId) : shots.find((s) => Number(s.shotNo) === wantedNo);
        if (!shot) blockers.push('找不到分镜');
      }

      const patch = String(args?.promptPatch || '');
      if (shot && token && !blockers.length) {
        const replace = String(args?.promptMode || 'append') === 'replace';
        if (patch) {
          const next = replace ? patch : `${String(shot.prompt || '')}\n\n${patch}`.trim();
          const put = await httpJson(`${base}/api/v1/story-shots/${shot.id}`, { method: 'PUT', token, body: { prompt: next } });
          if (put.status === 200) {
            shotPromptUpdated = true;
            promptLength = next.length;
            shot = put.json?.data || shot;
          } else {
            blockers.push(`更新 shot.prompt 失败（${put.status}）`);
          }
        }
        const variantPatch = String(args?.variantPatch || patch);
        const hasVariantExtra = Boolean(args?.subtitlePolicy || args?.negativePrompt);
        if (args?.syncVariants !== false && (variantPatch || hasVariantExtra)) {
          const res = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
          const fresh = (res.json?.data?.items || []).find((s) => s.id === shot.id) || shot;
          for (const variant of fresh.variants || []) {
            const current = String(variant.prompt || '');
            const next = variantPatch ? (replace ? variantPatch : `${current}\n\n${variantPatch}`.trim()) : '';
            const post = await httpJson(`${base}/api/v1/story-shot-variants/${variant.id}`, {
              method: 'POST',
              token,
              body: {
                ...(next ? { prompt: next } : {}),
                ...(args?.subtitlePolicy ? { subtitlePolicy: String(args.subtitlePolicy) } : {}),
                ...(args?.negativePrompt ? { negativePrompt: String(args.negativePrompt) } : {}),
              },
            });
            if (post.status === 200) variantsUpdated += 1;
          }
        }
      }

      return compactNulls({
        ok: blockers.length === 0,
        runId,
        shotId: String(shot?.id || ''),
        shotNo: Number(shot?.shotNo) || 0,
        shotPromptUpdated,
        variantsUpdated,
        promptLength,
        blockers,
      });
    },
  });
}
