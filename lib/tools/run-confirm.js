import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { variantHasImage } from '../story/image-state.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_run_confirm',
        description: '资产图人工/自动确认：给已出图但未确认的变体打 confirmed 标记（写 variant metadata，不 lock）。',
        parameters: {
          runId: { type: 'string', description: 'run_start 返回的 runId' },
          assetName: { type: 'string', description: '只确认某个资产（可空=全部已出图变体）' },
          confirmedBy: { type: 'string', description: 'agent / user（manual 资产审查必须由用户确认并传 user；默认 agent 不会解锁分镜）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              confirmed: { type: 'number' },
              total: { type: 'number' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [`confirm ${value.runId}: ${value.confirmed}/${value.total}`];
            for (const b of value.blockers || []) lines.push(`  · ${b}`);
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const runId = String(args?.runId || '');
          const assetName = String(args?.assetName || '');
          const confirmedBy = String(args?.confirmedBy || 'agent');
          const blockers = [];
          let confirmed = 0;
          let total = 0;
          let remaining = 0;
          const state = readRunState(runId);
          if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          if (state && token && !blockers.length) {
            const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
            for (const asset of assetsRes.json?.data?.items || []) {
              if (assetName && asset.name !== assetName) continue;
              const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
              for (const v of vs.json?.data?.items || []) {
                if (!variantHasImage(v)) continue;
                total += 1;
                const meta = v.metadata && typeof v.metadata === 'object' ? v.metadata : {};
                if (meta.confirmed === true) continue;
                const r = await httpJson(`${base}/api/v1/story-asset-variants/${v.id}`, {
                  method: 'POST',
                  token,
                  body: { metadata: { ...meta, confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy } },
                });
                if (r.status === 200) confirmed += 1;
                else remaining += 1;
              }
            }
            // 只确认单个资产时不能把整个 run 标记为“全部资产已确认”。
            if (!assetName && total > 0 && remaining === 0) {
              writeRunState(runId, {
                ...state,
                needHuman: false,
                assetsConfirmed: true,
                assetsConfirmedBy: confirmedBy,
                assetsConfirmedAt: new Date().toISOString(),
              });
            }
          }

          return compactNulls({ ok: blockers.length === 0, runId, confirmed, total, blockers });
        },
})
}
