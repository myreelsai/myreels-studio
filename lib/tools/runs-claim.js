import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { authStatus } from '../core/auth.js';
import { ownerFields } from '../core/owner.js';
import { stateDir, writeRunState } from '../core/state.js';
import { compactNulls } from '../core/util.js';

export default function createTool() {
  return defineTool({
    name: 'myreels_runs_claim',
    description: '把本机旧 run（没有 ownerKey 的任务）认领给当前操作者，用于恢复历史任务；不会删除或上传内容。必须由用户明确确认后传 confirm=true。',
    parameters: {
      confirm: { type: 'boolean', description: '必须由用户确认认领旧任务后传 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          claimed: { type: 'number' },
          skipped: { type: 'number' },
          ownerKey: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`runs_claim: ${value.ok ? '完成' : '失败'}（认领 ${value.claimed} 个，跳过 ${value.skipped} 个）`];
        if (value.ownerKey) lines.push(`- 操作者: ${value.ownerKey}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const blockers = [];
      if (args?.confirm !== true) blockers.push('需要用户明确确认后才能认领旧任务（confirm=true）');
      const session = authStatus();
      if (!session.userId) blockers.push('当前没有有效登录用户');
      if (blockers.length) return { ok: false, claimed: 0, skipped: 0, ownerKey: session.ownerKey || '', blockers };

      let claimed = 0;
      let skipped = 0;
      try {
        for (const file of readdirSync(stateDir())) {
          if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
          let state = null;
          try {
            state = JSON.parse(readFileSync(join(stateDir(), file), 'utf8'));
          } catch {
            skipped += 1;
            continue;
          }
          if (!state?.runId) {
            skipped += 1;
            continue;
          }
          if (state.ownerKey) {
            skipped += 1;
            continue;
          }
          if (state.ownerUserId && String(state.ownerUserId) !== String(session.userId)) {
            skipped += 1;
            continue;
          }
          writeRunState(state.runId, {
            ...state,
            ...ownerFields({
              userId: session.userId,
              ownerKey: session.ownerKey,
              operatorType: session.operatorType,
              operatorSubaccountId: session.operatorSubaccountId,
              operatorLabel: session.operatorLabel,
              username: session.username,
            }),
            legacyClaimedAt: new Date().toISOString(),
          });
          claimed += 1;
        }
      } catch (error) {
        blockers.push(`读取 state 目录失败：${String(error?.message || error)}`);
      }
      return compactNulls({ ok: blockers.length === 0, claimed, skipped, ownerKey: session.ownerKey || '', blockers });
    },
  });
}
