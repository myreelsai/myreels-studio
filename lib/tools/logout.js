import { defineTool } from '@deepseek-ai/dsh-tools';
import { logoutAuthSession, authStatus } from '../core/auth.js';
import { compactNulls } from '../core/util.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_logout',
    description: '退出 MyReels Studio 插件本地登录（免费）：清除插件会话，不会退出 MyReels 网页登录，也不会删除项目数据。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          loggedOut: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `logout: ${value.ok ? '已退出插件登录' : '失败'}\n- ${value.message || ''}` }];
      },
    },
    async execute() {
      logoutAuthSession();
      const status = authStatus();
      return compactNulls({
        ok: status.loggedOut,
        loggedOut: status.loggedOut,
        message: status.loggedOut ? '已清除插件登录状态，项目文件未删除；重新登录前不会自动使用旧凭据。' : '退出失败',
      });
    },
  });
}
