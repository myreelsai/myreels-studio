import { defineTool } from '@deepseek-ai/dsh-tools';
import { configOf } from '../config.js';
import { readRunState } from '../core/state.js';
import { isAutonomyEnabled } from '../core/autonomy.js';
import { compactNulls } from '../core/util.js';
import statusFactory from './run-status.js';
import advanceFactory from './run-advance.js';
import renderFactory from './render.js';
import reportFactory from './report.js';
import preflightFactory from './preflight.js';
import refcheckFactory from './refcheck.js';

export default function createTool(config) {
  return defineTool({
    name: 'myreels_auto',
    description: '自动推进一个 run：检查分析/资产/预检/参考图，按全局自主优化开关做安全修复，生成缺失分镜、渲染和报告。默认 dry=true；真正生成需要 allowGenerate=true。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      dry: { type: 'boolean', description: '只检查不生成（默认 true）' },
      allowGenerate: { type: 'boolean', description: '允许真正生成（默认 false）' },
      skipRender: { type: 'boolean', description: '跳过自动渲染（默认 false）' },
      maxShots: { type: 'number', description: '本次最多推进几个分镜（默认 3）' },
      maxAssets: { type: 'number', description: '保留参数：最多补几个资产图（默认 10）' },
      budgetPoints: { type: 'number', description: '可选本次预算上限' },
      retryFailed: { type: 'boolean', description: '生成失败自动重试（默认跟随自主优化）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          dry: { type: 'boolean' },
          analysisDone: { type: 'boolean' },
          assetsGenerated: { type: 'number' },
          shotsGenerated: { type: 'number' },
          subtitlePath: { type: 'string' },
          renderPath: { type: 'string' },
          reportPath: { type: 'string' },
          remainingRefIssues: { type: 'number' },
          stages: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(args, value) {
        const lines = [
          `auto ${value.runId}: ${value.ok ? 'ok' : '完成但有阻断'}${value.dry ? '（dry）' : ''}`,
          `- 分镜生成: ${value.shotsGenerated}`,
        ];
        if (value.renderPath) lines.push(`- 成片: ${value.renderPath}`);
        if (value.reportPath) lines.push(`- 报告: ${value.reportPath}`);
        for (const stage of value.stages || []) lines.push(`  · ${stage}`);
        for (const blocker of value.blockers || []) lines.push(`  ! ${blocker}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const cfg = configOf(config);
      const runId = String(args?.runId || '');
      const dry = args?.dry !== false;
      const allowGenerate = args?.allowGenerate === true;
      const skipRender = args?.skipRender === true;
      const maxShots = Math.max(1, Number(args?.maxShots || 3));
      const retryFailed = args?.retryFailed === true || isAutonomyEnabled('auto_generation_retry');
      const stages = [];
      const blockers = [];
      let assetsGenerated = 0;
      let shotsGenerated = 0;
      let renderPath = '';
      let reportPath = '';
      let remainingRefIssues = 0;

      if (!readRunState(runId)) {
        return compactNulls({
          ok: false, runId, dry, analysisDone: false, assetsGenerated, shotsGenerated,
          renderPath, reportPath, remainingRefIssues, stages, blockers: [`找不到 state：${runId || '(空)'}`],
        });
      }

      const statusTool = statusFactory(config);
      let status = await statusTool.execute({ runId });
      const analysisDone = String(status?.analysisStatus || '') === 'completed'
        || String(status?.stage || '').includes('ANALYSIS_DONE');
      stages.push(`状态: stage=${status?.stage || '?'} analysis=${status?.analysisStatus || '?'} assets=${status?.assetsWithImage ?? '?'}/${status?.assetsCount ?? '?'} videos=${status?.videoCount ?? '?'}/${status?.shotsCount ?? '?'}`);
      for (const blocker of status?.blockers || []) blockers.push(blocker);

      const auditRefs = isAutonomyEnabled('asset_reference_audit');
      const refcheckTool = refcheckFactory(config);
      const refcheck = auditRefs ? await refcheckTool.execute({ runId }) : { issues: [], tags: 0 };
      const refIssues = refcheck?.issues || [];
      const continuityIssues = refIssues.filter((issue) => String(issue.status || '').startsWith('continuity-'));
      const hardRefIssues = refIssues.filter((issue) => !String(issue.status || '').startsWith('continuity-'));
      if (continuityIssues.length) stages.push(`连续性: ${continuityIssues.length} 个连续场景服装变化警告（不阻断生成）`);
      stages.push(auditRefs ? `参考图: ${refcheck?.tags ?? 0} 标签 / ${hardRefIssues.length} 问题` : '参考图审查: 已关闭自动审查');

      if (!analysisDone) {
        return compactNulls({
          ok: dry, runId, dry, analysisDone, assetsGenerated, shotsGenerated,
          renderPath, reportPath, remainingRefIssues: hardRefIssues.length, stages,
          blockers: [...blockers, '分析未完成，稍后再跑'],
        });
      }

      if (isAutonomyEnabled('preflight_gate')) {
        try {
          const pf = await preflightFactory(config).execute({ runId });
          stages.push(`预检: ${pf?.summary?.errors ?? 0} errors / ${pf?.summary?.warnings ?? 0} warnings`);
          for (const blocker of pf?.blockers || []) blockers.push(blocker);
        } catch (error) {
          stages.push(`预检: 跳过（${String(error?.message || error)}）`);
        }
      } else {
        stages.push('预检: 已关闭生成前自动预检');
      }

      if (!dry) {
        const advanceTool = advanceFactory(config);
        if (allowGenerate) {
          const maxAssets = Math.max(0, Number(args?.maxAssets ?? 10));
          const repairAssets = isAutonomyEnabled('asset_reference_repair');
          const fixable = hardRefIssues.filter((issue) => issue.status === 'variant-no-image' || issue.status === 'asset-no-image');
          if (fixable.length && !repairAssets) {
            stages.push(`补图: 已关闭自动补齐资产参考图（${fixable.length} 个缺图变体）`);
          } else if (repairAssets && fixable.length) {
            const seen = new Set();
            for (const issue of fixable.slice(0, maxAssets)) {
              const key = `${issue.asset}|${issue.variant}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const assetArgs = { runId, stage: 'assets', assetName: issue.asset, limit: 1, retryFailed };
              if (issue.variant) assetArgs.variantName = issue.variant;
              if (args?.budgetPoints !== undefined) assetArgs.budgetPoints = Number(args.budgetPoints);
              const r = await advanceTool.execute(assetArgs);
              if (!r?.ok) {
                if (r?.blockers?.length) blockers.push(...r.blockers);
                break;
              }
              const n = Number(r?.generatedCount || 0);
              if (n > 0) {
                assetsGenerated += n;
                stages.push(`补图: ${issue.asset}/${issue.variant || '默认'} → ${n} 张`);
              }
            }
          }
          const shotStatus = await statusTool.execute({ runId });
          const totalShots = Number(shotStatus?.shotsCount || 0);
          const doneVideos = Number(shotStatus?.videoCount || 0);
          if (doneVideos < totalShots) {
            // 交给 run_advance 的滚动池：最多 maxShots 个总量，并发按项目 videoParallelism 实时补位。
            const r = await advanceTool.execute({ runId, stage: 'shots', shotLimit: Math.max(1, maxShots), retryFailed });
            const n = Number(r?.generatedCount || 0);
            if (n > 0) {
              shotsGenerated += n;
              stages.push(`分镜: 滚动生成完成 ${n} 个`);
            }
            if (r?.ok === false) {
              for (const blocker of r?.blockers || []) blockers.push(blocker);
            }
          }
        } else {
          stages.push('生成: 未允许（需要 allowGenerate=true）');
        }

        if (!skipRender && isAutonomyEnabled('auto_render')) {
          const r = await renderFactory(config).execute({ runId });
          if (r?.ok) {
            renderPath = String(r.path || '');
            stages.push(`渲染: ${r.partial ? '已有部分成片' : '完成'}${renderPath ? ` ${renderPath}` : ''}`);
          } else {
            for (const blocker of r?.blockers || []) blockers.push(blocker);
          }
        } else if (!skipRender) {
          stages.push('渲染: 已关闭自动渲染');
        }

        if (isAutonomyEnabled('auto_report')) {
          const r = await reportFactory(config).execute({ runId });
          if (r?.ok) {
            reportPath = String(r.path || '');
            stages.push(`报告: ${reportPath}`);
          } else {
            for (const blocker of r?.blockers || []) blockers.push(blocker);
          }
        }
      }

      status = await statusTool.execute({ runId }).catch(() => status);
      remainingRefIssues = hardRefIssues.length;
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        dry,
        analysisDone,
        assetsGenerated,
        shotsGenerated,
        subtitlePath: '',
        renderPath,
        reportPath,
        remainingRefIssues,
        stages,
        blockers,
      });
    },
  });
}
