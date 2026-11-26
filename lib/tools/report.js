import { writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState } from '../core/state.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';
import { compactNulls } from '../core/util.js';

function listArtifacts(runId) {
  const root = runsRoot();
  const out = [];
  for (const sub of ['renders', 'subtitles', 'reports']) {
    const dir = join(root, sub);
    try {
      for (const name of readdirSync(dir)) {
        if (!name.includes(runId)) continue;
        const file = join(dir, name);
        const stat = statSync(file);
        out.push({ path: file, mb: (stat.size / 1048576).toFixed(1) });
      }
    } catch {
      /* dir missing */
    }
  }
  return out;
}

export default function createTool(config) {
  return defineTool({
        name: 'myreels_report',
        description: '根据 state 与故事台数据生成 Markdown 报告（项目/集/资产/分镜/视频状态），写到本地文件，不调用生成接口。',
        parameters: {
          runId: { type: 'string', description: 'run_start 返回的 runId' },
          outPath: { type: 'string', description: '报告路径（可空，默认 <产物根>/<剧名>/epNN/report.md）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              path: { type: 'string' },
              assets: { type: 'number' },
              variants: { type: 'number' },
              shots: { type: 'number' },
              videos: { type: 'number' },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(value.ok ? `report ${value.runId}` : `report ${value.runId} 失败`);
            if (value.path) lines.push(`- 文件: ${value.path}`);
            lines.push(`- 资产 ${value.assets} / 变体 ${value.variants} / 分镜 ${value.shots} / 视频 ${value.videos}`);
            for (const b of value.blockers || []) lines.push(`  · ${b}`);
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const runId = String(args?.runId || '');
          const blockers = [];
          const state = readRunState(runId);
          if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');

          let assets = 0;
          let variants = 0;
          let shots = 0;
          let videos = 0;
          const lines = [`# MyReels run ${runId}`, ''];
          if (state && token && !blockers.length) {
            const p = await httpJson(`${base}/api/v1/story-projects/${state.projectId}`, { token });
            if (p.status !== 200) {
              blockers.push(`故事台接口 ${p.status}：${String(p.json?.error || p.text || '').slice(0, 120)}`);
              lines.push(`- 接口错误: ${p.status} ${String(p.json?.error || '').slice(0, 120)}`);
            }
            const project = p.status === 200 ? (p.json?.data || {}) : {};
            lines.push(`- 项目: ${project.title || ''}（${state.projectId}）`);
            lines.push(`- 画布组: ${state.groupId || '-'} / 画布: ${state.canvasProjectId || '-'}`);
            if (p.status === 200) {
              const eps = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/episodes`, { token });
              if (eps.status !== 200) blockers.push(`集列表 ${eps.status}`);
              for (const ep of eps.json?.data?.items || []) {
                lines.push(`- 集 ${ep.episodeNo}: ${ep.scriptAnalysisStatus}（${ep.status}）`);
              }
              lines.push('');
              lines.push('## 资产');
              const assetRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
              if (assetRes.status !== 200) blockers.push(`资产列表 ${assetRes.status}`);
              const assetItems = assetRes.json?.data?.items || [];
              assets = assetItems.length;
              for (const asset of assetItems) {
                const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
                const list = vs.json?.data?.items || [];
                variants += list.length;
                const withImg = list.filter((x) => x.imageUrl).length;
                lines.push(`- ${asset.assetType} ${asset.name}: ${withImg}/${list.length} 有图`);
              }
              lines.push('');
              lines.push('## 分镜');
              const shotRes = await httpJson(`${base}/api/v1/story-episodes/${state.episodeId}/shots`, { token });
              if (shotRes.status !== 200) blockers.push(`分镜列表 ${shotRes.status}`);
              for (const shot of shotRes.json?.data?.items || []) {
                shots += 1;
                const v = shot.outputs?.latestVideo || null;
                if (v?.status === 'completed') videos += 1;
                lines.push(`- 分镜 ${shot.shotNo}: video=${v ? `${v.status}` : 'none'}`);
              }
              lines.push('');
            }
            lines.push('## 产物');
            if (state?.renderPath) lines.push(`- 成片: ${state.renderPath}（${state.renderSizeMb || '-'} MB / ${state.renderDurationSec || '-'}s）`);
            if (state?.subtitlePath) lines.push(`- 字幕: ${state.subtitlePath}`);
            const known = new Set([state?.renderPath, state?.subtitlePath].filter(Boolean));
            const artifacts = listArtifacts(runId).filter((a) => !known.has(a.path));
            if (artifacts.length) {
              for (const item of artifacts) lines.push(`- ${item.path}（${item.mb} MB）`);
            } else {
              lines.push('- （无：先运行 myreels_subtitle / myreels_render / myreels_report）');
            }
            lines.push('## 汇总');
            lines.push(`- 资产 ${assets} / 变体 ${variants} / 分镜 ${shots} / 视频 ${videos}`);
            if (state?.episodePlannedSec) {
              lines.push(`- 集时长: 实际 ${state.renderDurationSec || '-'}s / 计划 ${state.episodePlannedSec}s（差 ${state.episodeShortfallSec ?? '-'}s）`);
            }
            if (blockers.length) lines.push(`- 阻塞: ${blockers.join('；')}`);
            let outPath = String(args?.outPath || '');
            if (!outPath) outPath = layoutOfState(state)?.reportPath || join(runsRoot(), '.reports', `${runId}.md`);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, lines.join('\n'));
            return compactNulls({ ok: blockers.length === 0, runId, path: outPath, assets, variants, shots, videos, blockers });
          }

          return compactNulls({ ok: false, runId, path: '', assets, variants, shots, videos, blockers });
        },
})
}
