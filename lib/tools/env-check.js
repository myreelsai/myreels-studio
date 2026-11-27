import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { authStatus, credentialsOf, decodeJwt, loginToken } from '../core/auth.js';
import { summarizePoints, compactNulls } from '../core/util.js';

const normalizeBase = (config) => (config.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');

async function runChecks(config, { verbose } = {}) {
  const base = normalizeBase(config);
  const creds = credentialsOf(config);
  const checks = [];
  const blockers = [];

  const token = await loginToken(base, creds);
  const claims = token ? decodeJwt(token) : null;
  const tenantUserId = String(claims?.tenantUserId || claims?.userId || '');
  const authenticated = Boolean(token);

  checks.push({
    name: 'login',
    status: authenticated ? 'ok' : 'fail',
    detail: authenticated ? 'MyReels SSO 登录态有效' : '未登录，请先完成 MyReels SSO 登录',
  });
  if (!authenticated) {
    blockers.push('未登录，请先完成 MyReels SSO 登录');
  }

  let balancePoints = null;
  let modelsCount = 0;

  if (authenticated) {
    const projectGroups = await httpJson(`${base}/api/v1/canvas/project-groups?limit=1`, { token });
    const total = projectGroups.json?.data?.pagination?.total ?? null;
    checks.push({
      name: 'project-groups',
      status: projectGroups.status === 200 ? 'ok' : 'fail',
      detail: projectGroups.status === 200 ? `HTTP 200, total=${total ?? '?'}` : `HTTP ${projectGroups.status}`,
    });
    if (projectGroups.status !== 200) blockers.push(`故事台项目组接口不可用（HTTP ${projectGroups.status}）`);

    const balance = await httpJson(`${base}/api/v1/users/balance/details`, { token });
    balancePoints = summarizePoints(balance.json);
    checks.push({
      name: 'balance',
      status: balance.status === 200 ? 'ok' : 'fail',
      detail: balance.status === 200 ? `points=${balancePoints ?? '?'}` : `HTTP ${balance.status}`,
    });
    if (balance.status !== 200) blockers.push(`余额接口不可用（HTTP ${balance.status}）`);

    const toolsRes = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
    const tools = toolsRes.json?.data?.items || [];
    modelsCount = tools.length;
    checks.push({
      name: 'model-tools',
      status: toolsRes.status === 200 ? 'ok' : 'fail',
      detail: toolsRes.status === 200 ? `HTTP 200, tools=${modelsCount}` : `HTTP ${toolsRes.status}`,
    });
    if (toolsRes.status !== 200) blockers.push(`模型目录不可用（HTTP ${toolsRes.status}）`);
  }

  return compactNulls({
    ok: blockers.length === 0,
    dry: false,
    tenantUserId,
    balancePoints,
    modelsCount,
    checks,
    blockers,
  });
}

function dryRun(config) {
  const cfg = configOf(config);
  const status = authStatus();
  const blockers = status.hasToken ? [] : ['未登录，请先完成 MyReels SSO 登录'];
  return compactNulls({
    ok: blockers.length === 0,
    dry: true,
    tenantUserId: '',
    balancePoints: null,
    modelsCount: 0,
    checks: [
      { name: 'config', status: 'ok', detail: `apiBaseUrl=${cfg.apiBaseUrl || DEFAULT_API}` },
      { name: 'login', status: status.hasToken ? 'ok' : 'fail', detail: status.hasToken ? '已登录' : '未登录' },
    ],
    blockers,
  });
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_env_check',
    description: '校验 MyReels 登录态、故事项目、余额和模型目录。dry=true 时只检查配置，不发网络请求。',
    parameters: {
      dry: { type: 'boolean', description: '只做配置检查（默认 false）' },
      verbose: { type: 'boolean', description: '输出明细（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          dry: { type: 'boolean' },
          tenantUserId: { type: 'string' },
          balancePoints: { type: 'number' },
          modelsCount: { type: 'number' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                status: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [];
        lines.push(`${value.ok ? 'MyReels 环境 OK' : 'MyReels 环境未就绪'}${value.dry ? '（dry-run）' : ''}`);
        if (value.tenantUserId) lines.push(`- tenantUserId: ${value.tenantUserId}`);
        if (value.balancePoints !== null && value.balancePoints !== undefined) {
          lines.push(`- 余额: ${value.balancePoints} 点`);
        }
        if (value.modelsCount) lines.push(`- 模型目录: ${value.modelsCount} 个`);
        for (const check of value.checks || []) {
          const mark = check.status === 'ok' ? 'OK' : check.status === 'skip' ? 'SKIP' : check.status === 'info' ? 'INFO' : 'FAIL';
          lines.push(`- [${mark}] ${check.name}: ${check.detail}`);
        }
        if (value.blockers?.length) {
          lines.push('阻塞项：');
          for (const item of value.blockers) lines.push(`  · ${item}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      if (args?.dry === true) return dryRun(cfg);
      return runChecks(cfg, { verbose: args?.verbose === true });
    },
  });
}
