import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { episodeLayout, readStorageConfig, runsRoot, storageConfigPath, workspaceDir } from '../storage/layout.js';
import { stateDir } from '../core/state.js';
import { compactNulls } from '../core/util.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_storage',
    description:
      '查看/设置产物根目录：默认 <workspace>/myreels-runs，可改成任意目录。写入后资产图、分镜视频、成片、字幕、报告、预览都落在该目录（<root>/<剧名>/epNN/）；state 注册表仍在 ~/.dsh/storages/myreels-studio。',
    parameters: {
      action: { type: 'string', description: 'get（默认，只读）/ set（写本机配置）' },
      workspaceDir: { type: 'string', description: 'set：Harness 工作区路径，例如 E:\\workspace（空=不改）' },
      runsRoot: { type: 'string', description: 'set：产物根目录，例如 E:\\workspace\\myreels-runs（空=不改）' },
      sampleProject: { type: 'string', description: '可选：用这个剧名演示目录结构（默认「示例剧」）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          configPath: { type: 'string' },
          workspaceDir: { type: 'string' },
          runsRoot: { type: 'string' },
          stateDir: { type: 'string' },
          projectDir: { type: 'string' },
          episodeDir: { type: 'string' },
          renderPath: { type: 'string' },
          assetsDir: { type: 'string' },
          shotsDir: { type: 'string' },
          insideWorkspace: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [`storage ${value.action}: ${value.ok ? 'ok' : '失败'}`];
        lines.push(`- 配置文件: ${value.configPath}`);
        lines.push(`- 工作区: ${value.workspaceDir}`);
        lines.push(`- 产物根目录: ${value.runsRoot}${value.insideWorkspace ? '（在工作区内）' : '（不在工作区内）'}`);
        lines.push(`- state 注册表: ${value.stateDir}`);
        if (value.episodeDir) {
          lines.push(`- 目录结构: ${value.episodeDir}`);
          lines.push(`    · 资产: ${value.assetsDir}`);
          lines.push(`    · 分镜: ${value.shotsDir}`);
          lines.push(`    · 成片: ${value.renderPath}`);
        }
        for (const w of value.warnings || []) lines.push(`  ! ${w}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const action = String(args?.action || 'get') === 'set' ? 'set' : 'get';
      const blockers = [];
      const warnings = [];
      const file = storageConfigPath();
      const stored = readStorageConfig();
      if (action === 'set') {
        const nextWorkspace = String(args?.workspaceDir || '').trim();
        const nextRuns = String(args?.runsRoot || '').trim();
        if (!nextWorkspace && !nextRuns) blockers.push('set 需要 workspaceDir 或 runsRoot 至少一个');
        if (!blockers.length) {
          try {
            mkdirSync(dirname(file), { recursive: true });
            const merged = { ...stored };
            if (nextWorkspace) merged.workspaceDir = nextWorkspace;
            if (nextRuns) merged.runsRoot = nextRuns;
            merged.updatedAt = new Date().toISOString();
            writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
          } catch (err) {
            blockers.push(`写配置失败：${String(err?.message || err)}`);
          }
        }
      }
      const resolvedWorkspace = workspaceDir();
      const resolvedRoot = runsRoot();
      const layout = episodeLayout({
        projectTitle: String(args?.sampleProject || '示例剧'),
        episodeNo: 1,
      });
      const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const insideWorkspace = Boolean(resolvedWorkspace) && norm(resolvedRoot).startsWith(norm(resolvedWorkspace));
      if (!insideWorkspace) warnings.push('产物根目录不在工作区内，成片可能不在 Harness 文件面板可见范围');
      if (action === 'set' && !blockers.length) {
        warnings.push('新目录对之后新建的 run 与下一次渲染/预览生效；已生成的旧 run 需手动搬移或重新渲染');
      }
      return compactNulls({
        ok: blockers.length === 0,
        action,
        configPath: file,
        workspaceDir: resolvedWorkspace,
        runsRoot: resolvedRoot,
        stateDir: stateDir(),
        projectDir: layout.projectDir,
        episodeDir: layout.episodeDir,
        renderPath: layout.renderPath,
        assetsDir: layout.assetsDir,
        shotsDir: layout.shotsDir,
        insideWorkspace,
        warnings,
        blockers,
      });
    },
  });
}
