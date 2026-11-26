import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { auditShotContract } from '../story/contract.js';
import { isAutonomyEnabled } from '../core/autonomy.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_shot_audit',
    description: '生成前镜头合同审计（免费）：检查节拍密度/参考图数量/道具持有/动作分解/字幕/连续性/负面约束，返回问题；补丁由 Harness 决定，不自动生成。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      shotNo: { type: 'number', description: '只审计某个分镜（可空=全部）' },
      maxRefs: { type: 'number', description: '每镜建议参考图上限（默认 4）' },
      maxBeatsPer15s: { type: 'number', description: '每 15s 建议节拍上限（默认 6）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                shotNo: { type: 'number' },
                duration: { type: 'number' },
                refs: { type: 'number' },
                beats: { type: 'number' },
                ready: { type: 'boolean' },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      code: { type: 'string' },
                      level: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const bad = value.results.filter((r) => r.issues.length);
        const lines = [`shot_audit ${value.runId}: ${bad.length}/${value.results.length} 镜有问题`];
        for (const item of bad) {
          lines.push(`- 分镜 ${item.shotNo}（${item.duration}s / ${item.beats} 拍 / ${item.refs} 图）`);
          for (const issue of item.issues) lines.push(`    · ${issue.message}`);
        }
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
      const results = [];
      if (state && token) {
        const shots = (await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token })).json?.data?.items || [];
        const shotNo = Number(args?.shotNo || 0);
        for (const shot of shots) {
          if (shotNo && Number(shot.shotNo) !== shotNo) continue;
          const audit = auditShotContract(shot, {
            maxRefs: Number(args?.maxRefs || 4),
            maxBeatsPer15s: Number(args?.maxBeatsPer15s || 6),
            checkDialogueDuration: isAutonomyEnabled('shot_duration_fit'),
          });
          results.push(audit);
        }
      }
      return compactNulls({ ok: blockers.length === 0, runId, results, blockers });
    },
  });
}
