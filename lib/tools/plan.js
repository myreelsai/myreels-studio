import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { compactNulls } from '../core/util.js';
import { normalizeRatios } from '../story/prompt.js';
import { fetchStyleCandidates } from '../story/client.js';
import { modelOptionsFromTools } from '../story/models.js';

export default function createTool(config) {
  return defineTool({
        name: 'myreels_plan',
        description:
          '生成 MyReels 设置确认卡（画风/画幅/比例/预算/集范围/资产确认）：继承项目 metadata、给出 art-style 候选；不下单、不扣点。确认后把 settings 交给 myreels_run_start。',
        parameters: {
          projectId: { type: 'string', description: '继承设置的项目 id（可空）' },
          title: { type: 'string', description: '剧名（可空）' },
          aspect: { type: 'string', description: '画幅：9:16 / 16:9 / 1:1（可空）' },
          stylePageId: { type: 'string', description: '画风 wiki pageId（可空）' },
          styleText: { type: 'string', description: '自定义画风文本（可空）' },
          budgetPoints: { type: 'number', description: '预算点数（0=未设）' },
          episodeStart: { type: 'number', description: '起始集号（默认 1）' },
          episodeEnd: { type: 'number', description: '结束集号（默认 2）' },
          assetReview: { type: 'string', description: 'manual / auto / off（默认 manual）' },
          imageModel: { type: 'string', description: '图片模型显示名（可空=用默认）' },
          imageModelSlug: { type: 'string', description: '图片模型 slug（可空=用默认）' },
          videoModelSlug: { type: 'string', description: '视频模型 slug（可空=用默认）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              projectId: { type: 'string' },
              title: { type: 'string' },
              aspect: { type: 'string' },
              ratios: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  character: { type: 'string' },
                  scene: { type: 'string' },
                  image: { type: 'string' },
                  video: { type: 'string' },
                  item: { type: 'string' },
                  creature: { type: 'string' },
                },
              },
              stylePageId: { type: 'string' },
              styleTitle: { type: 'string' },
              stylePrompt: { type: 'string' },
              budgetPoints: { type: 'number' },
              episodeStart: { type: 'number' },
              episodeEnd: { type: 'number' },
              assetReview: { type: 'string' },
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    pageId: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                  },
                },
              },
              questions: { type: 'array', items: { type: 'string' } },
              sources: { type: 'array', items: { type: 'string' } },
              models: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  channel: { type: 'string' },
                  image: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        modelName: { type: 'string' },
                        name: { type: 'string' },
                        cost: { type: 'number' },
                        slug: { type: 'string' },
                        inBoth: { type: 'boolean' },
                        maxDuration: { type: 'number' },
                      },
                    },
                  },
                  video: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        modelName: { type: 'string' },
                        name: { type: 'string' },
                        cost: { type: 'number' },
                        slug: { type: 'string' },
                        inBoth: { type: 'boolean' },
                        maxDuration: { type: 'number' },
                      },
                    },
                  },
                  onlyTools: { type: 'array', items: { type: 'string' } },
                  current: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      image: { type: 'string' },
                      video: { type: 'string' },
                    },
                  },
                },
              },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const lines = [];
            lines.push(value.ok ? 'MyReels 设置卡（未下单）' : 'MyReels 设置卡（有阻塞）');
            lines.push(`- 项目: ${value.title || '(未命名)'}${value.projectId ? ` / ${value.projectId}` : ''}`);
            lines.push(`- 画幅: ${value.aspect}`);
            lines.push(
              `- 比例: 角色 ${value.ratios.character} / 场景 ${value.ratios.scene} / 图 ${value.ratios.image} / 视频 ${value.ratios.video} / 物品 ${value.ratios.item} / 生物 ${value.ratios.creature}`,
            );
            lines.push(`- 画风: ${value.styleTitle || value.stylePageId || value.stylePrompt || '(未选)'}`);
            lines.push(`- 预算: ${value.budgetPoints || '(未设)'} 点`);
            lines.push(`- 集范围: ${value.episodeStart}–${value.episodeEnd}`);
            lines.push(`- 资产确认: ${value.assetReview}`);
            if (value.models) {
              lines.push('- 模型通道: story-tools（生成实际使用故事台工具目录，不再比对开放 API 目录）');
              const fmt = (list, withSlug) =>
                list
                  .map((m) => `${m.name || m.modelName}${withSlug && m.slug ? `（slug ${m.slug}）` : ''} ${m.cost}点${m.maxDuration ? ` ≤${m.maxDuration}s` : ''}`)
                  .join(' / ') || '(无)';
              lines.push(`- 可选图模: ${fmt(value.models.image, true)}（生成时传 imageModelSlug）`);
              lines.push(`- 可选视频: ${fmt(value.models.video, true)}（生成时传 videoModelSlug）`);
              lines.push(`- 当前默认: 图 ${value.models.current.image || '?'} / 视频 ${value.models.current.video || '?'}`);
              if (value.models.onlyTools.length) lines.push(`- 仅在故事台工具目录（不能走开放 API 计费）: ${value.models.onlyTools.join(', ')}`);
            }
            if (value.candidates?.length) {
              lines.push('画风候选（art-style）：');
              for (const c of value.candidates) {
                lines.push(`  · ${c.pageId} ${c.title}${c.summary ? ` — ${c.summary.slice(0, 30)}` : ''}`);
              }
            }
            if (value.questions?.length) {
              lines.push('待确认：');
              for (const q of value.questions) lines.push(`  ? ${q}`);
            }
            if (value.blockers?.length) {
              lines.push('阻塞项：');
              for (const b of value.blockers) lines.push(`  · ${b}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const cfg = configOf(config);
          const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
          const creds = credentialsOf(cfg);
          const input = args || {};
          const blockers = [];
          const sources = [];
          const questions = [];

          const token = await loginToken(base, creds);
          if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录，无法读取项目/候选');

          let project = null;
          if (input.projectId) {
            if (!token) {
              blockers.push('未登录，无法读取项目 metadata');
            } else {
              const r = await httpJson(`${base}/api/v1/story-projects/${input.projectId}`, { token });
              if (r.status === 200) project = r.json?.data || null;
              else blockers.push(`项目不可读（${r.status}）`);
            }
          }

          const meta = project?.metadata && typeof project.metadata === 'object' ? project.metadata : {};
          const ratios = normalizeRatios(meta);
          const aspect = String(input.aspect || ratios.video || '16:9');
          if (input.aspect) {
            ratios.character = aspect;
            ratios.scene = aspect;
            ratios.image = aspect;
            ratios.video = aspect;
            sources.push('aspect: hint');
          } else {
            sources.push(project ? 'aspect: project' : 'aspect: webui-default(16:9)');
          }

          const styleMeta =
            meta.defaultStyleWikiPrompt && typeof meta.defaultStyleWikiPrompt === 'object'
              ? meta.defaultStyleWikiPrompt
              : null;
          const styleIds = Array.isArray(meta.defaultStyleWikiPromptIds) ? meta.defaultStyleWikiPromptIds : [];
          const stylePageId = String(input.stylePageId || styleMeta?.pageId || styleIds[0] || '');
          const styleTitle = String(styleMeta?.title || '');
          const stylePrompt = String(input.styleText || styleMeta?.promptTemplate || '');
          sources.push(stylePageId || stylePrompt ? 'style: hint/project' : 'style: unset');

          const budgetPoints = Number(input.budgetPoints || 0);
          sources.push(budgetPoints > 0 ? 'budget: hint' : 'budget: unset');
          const episodeStart = Number(input.episodeStart || 1);
          const episodeEnd = Number(input.episodeEnd || Math.max(episodeStart, 2));
          sources.push('episodes: ' + (input.episodeStart || input.episodeEnd ? 'hint' : 'default(1-2)'));
          const assetReview = String(input.assetReview || 'manual');
          sources.push('assetReview: ' + (input.assetReview ? 'hint' : 'default(manual)'));

          const candidates = await fetchStyleCandidates(base, token);

          let imageModels = [];
          let videoModels = [];
          let onlyTools = [];
          if (token) {
            const toolsRes = await httpJson(`${base}/api/v1/tools?limit=400`, { token });
            const tools = toolsRes.json?.data?.items || [];
            const imageOptions = modelOptionsFromTools(tools, 'image');
            const videoOptions = modelOptionsFromTools(tools, 'video');
            const pin = (list, current) => {
              const idx = list.findIndex((m) => m.modelName === current.modelName || m.slug === current.slug);
              if (idx <= 0) return list;
              return [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
            };
            imageModels = pin(imageOptions.list, { slug: String(input.imageModelSlug || cfg.imageModelSlug || '') }).slice(0, 20);
            videoModels = pin(videoOptions.list, { slug: String(input.videoModelSlug || cfg.videoModelSlug || '') }).slice(0, 20);
            onlyTools = [];
          }

          if (!stylePageId && !stylePrompt) {
            questions.push('画风未选：从候选里挑一个 pageId，或直接给自定义画风文本（如「电影感写实人像」）');
          }
          if (!input.aspect) {
            blockers.push('画幅未选：必须显式选择 9:16 / 16:9 / 1:1 / 3:4，不再默认 16:9');
          }
          if (!budgetPoints) {
            questions.push('预算未设置：D14 熔断不会生效');
          }
          if (!input.episodeStart && !input.episodeEnd) {
            questions.push('默认先跑第 1–2 集，确认质量后再放量');
          }

          return compactNulls({
            ok: blockers.length === 0,
            projectId: String(input.projectId || ''),
            title: String(input.title || project?.title || ''),
            aspect,
            ratios,
            stylePageId,
            styleTitle,
            stylePrompt,
            budgetPoints,
            episodeStart,
            episodeEnd,
            assetReview,
            candidates,
            questions,
            sources,
            models: {
              channel: 'story-tools',
              image: imageModels,
              video: videoModels,
              onlyTools,
              current: {
                image: String(input.imageModelSlug || cfg.imageModelSlug || input.imageModel || cfg.imageModel || ''),
                video: String(input.videoModelSlug || cfg.videoModelSlug || ''),
              },
            },
            blockers,
          });
        },
})
}
