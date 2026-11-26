import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { compactNulls } from '../core/util.js';
import { putProjectMetadata } from '../story/client.js';
import { localProjectVisible } from '../core/owner.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_settings',
        description: '读取项目设置 metadata；传 metadataJson 时按 GET→merge→PUT 写回（T20：整体替换，必须合并）。',
        parameters: {
          projectId: { type: 'string', description: '项目 id' },
          metadataJson: { type: 'string', description: '要合并的 metadata JSON（可空；空=只读）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              projectId: { type: 'string' },
              written: { type: 'boolean' },
              metadataKeys: { type: 'array', items: { type: 'string' } },
              metadataJson: { type: 'string' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(value.ok ? `settings ${value.projectId}` : `settings ${value.projectId} 失败`);
            lines.push(`- 写入: ${value.written ? 'yes' : 'no'}`);
            lines.push(`- keys: ${(value.metadataKeys || []).join(', ')}`);
            for (const b of value.blockers || []) lines.push(`  · ${b}`);
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const projectId = String(args?.projectId || '');
          const blockers = [];
          let written = false;
          let metadata = null;
          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
          if (!projectId) blockers.push('缺少 projectId');

          if (token && projectId && !blockers.length) {
            const p = await httpJson(`${base}/api/v1/story-projects/${projectId}`, { token });
            if (p.status !== 200) blockers.push(`项目不可读（${p.status}）`);
            else {
              metadata = p.json?.data?.metadata && typeof p.json.data.metadata === 'object' ? p.json.data.metadata : {};
              if (!localProjectVisible(projectId, metadata)) {
                blockers.push('当前操作者无权访问该项目');
                metadata = null;
              }
            }

            const patchText = String(args?.metadataJson || '').trim();
            if (!blockers.length && patchText) {
              let patch = null;
              try {
                patch = JSON.parse(patchText);
              } catch {
                blockers.push('metadataJson 不是合法 JSON');
              }
              if (patch && typeof patch !== 'object') blockers.push('metadataJson 必须是对象');
              if (patch && typeof patch === 'object') {
                const merged = { ...metadata, ...patch };
                const put = await putProjectMetadata(base, token, projectId, merged);
                if (put.status === 200) {
                  written = true;
                  metadata = merged;
                } else {
                  blockers.push(`写设置失败（${put.status}）`);
                }
              }
            }
          }

          const keys = metadata ? Object.keys(metadata) : [];
          return compactNulls({
            ok: blockers.length === 0,
            projectId,
            written,
            metadataKeys: keys,
            metadataJson: JSON.stringify(metadata || {}),
            blockers,
          });
        },
})
}
