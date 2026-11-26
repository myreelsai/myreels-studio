import { defineTool } from '@deepseek-ai/dsh-tools';
import { autonomyStatus, setAutonomy } from '../core/autonomy.js';

export default function createTool() {
  return defineTool({
    name: 'myreels_autonomy',
    description: '查看或修改 MyReels 全局自主优化开关。用户说“关闭自动优化分镜提示词”“开启自动渲染”等时调用本工具；list 只读，set 写全局设置。',
    parameters: {
      action: { type: 'string', description: 'list / set（默认 list）' },
      id: { type: 'string', description: '开关 id（set 时使用）' },
      enabled: { type: 'boolean', description: 'set 时：true 开启，false 关闭' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
                default: { type: 'boolean' },
                enabled: { type: 'boolean' },
                locked: { type: 'boolean' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = ['MyReels 自主优化开关：'];
        for (const item of value.items || []) {
          const mark = item.locked ? '🔒' : item.enabled ? '✅' : '⛔';
          lines.push(`${mark} ${item.id}：${item.label}${item.locked ? '（固定开启）' : ''}`);
        }
        for (const b of value.blockers || []) lines.push(`- ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const action = String(args?.action || 'list');
      if (action === 'list') return { ok: true, ...autonomyStatus(), blockers: [] };
      try {
        const status = setAutonomy({ id: args?.id, enabled: args?.enabled });
        return { ok: true, ...status, blockers: [] };
      } catch (error) {
        return { ok: false, ...autonomyStatus(), blockers: [String(error?.message || error)] };
      }
    },
  });
}
