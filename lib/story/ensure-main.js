import { httpJson } from '../core/http.js';
import { waitTaskStatuses } from './client.js';
import { resolveAssetTemplateForAsset, styleWikiIdFromMetadata, ratioKeyFor, assetNeedsSubjectImage } from './templates.js';
import { assetOptimizePrompt } from './prompt.js';
import { variantHasImage } from './image-state.js';

/**
 * 主图优先：确保资产有主图，返回可用 URL。
 * 先生成资产级主图；失败时退化为已有变体图，避免变体在无垫图状态下生成。
 */
export async function ensureAssetMainImage({ base, token, asset, metadata, tool, state }) {
  if (!asset) return { url: '', taskId: '', fallback: false, blocker: '资产不存在' };
  if (String(asset.referenceImageUrl || '').trim()) return { url: String(asset.referenceImageUrl), taskId: '', fallback: false };
  if (!tool) return { url: '', taskId: '', fallback: false, blocker: '图片模型不存在' };
  const type = String(asset.assetType || '');
  if (!assetNeedsSubjectImage(type)) return { url: String(asset.referenceImageUrl || ''), taskId: '', fallback: false };
  let template = await resolveAssetTemplateForAsset(base, token, asset, type, metadata);
  if (!template.id) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    template = await resolveAssetTemplateForAsset(base, token, asset, type, metadata);
  }
  if (!template.id) return { url: '', taskId: '', fallback: false, blocker: `${type} 模板未选（重试后仍为空）` };
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const body = {
    assetType: type,
    assetIds: [asset.id],
    targetScope: 'selected',
    generationTaskConfig: {
      serviceId: tool.serviceId,
      promptResourceId: tool.id,
      taskType: 'image',
      promptField: 'prompt',
      userInput: {
        aspect_ratio: String(meta[ratioKeyFor(type)] || state?.settings?.aspect || '9:16'),
        size: '2K',
        n: 1,
        ...(assetOptimizePrompt(type) ? { optimizePrompt: assetOptimizePrompt(type) } : {}),
        ...(styleWikiIdFromMetadata(meta) ? { prompt1WikiIds: [styleWikiIdFromMetadata(meta)] } : {}),
        prompt2WikiIds: [template.id],
      },
      finalParameters: {
        source: 'story_workbench',
        assetType: type,
        outputType: 'image',
        modelId: tool.id,
        model: tool.modelName,
        modelName: tool.modelName,
      },
    },
  };
  const r = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets/generate-batch`, { method: 'POST', token, body });
  if (r.status < 200 || r.status >= 300) {
    return { url: '', taskId: '', fallback: false, blocker: `主图提交失败（${r.status}）` };
  }
  const taskId = String(r.json?.data?.items?.[0]?.taskId || '');
  if (taskId) {
    await waitTaskStatuses(base, token, [taskId], { intervalMs: 10000, maxRounds: 120 }).catch(() => null);
  }
  const fresh = (await httpJson(`${base}/api/v1/story-assets/${asset.id}`, { token })).json?.data || {};
  if (String(fresh.referenceImageUrl || '').trim()) {
    return { url: String(fresh.referenceImageUrl), taskId, fallback: false };
  }
  const vs = (await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token })).json?.data?.items || [];
  const chosen = vs.find((v) => variantHasImage(v));
  if (chosen) {
    const put = await httpJson(`${base}/api/v1/story-assets/${asset.id}`, {
      method: 'PUT',
      token,
      body: { referenceImageUrl: chosen.imageUrl || null, referenceUserFileId: chosen.userFileId || null },
    });
    if (put.status === 200) {
      return { url: String(chosen.imageUrl || ''), taskId, fallback: true };
    }
  }
  return { url: '', taskId, fallback: false, blocker: `主图任务未完成（提交 ${r.status}）` };
}
