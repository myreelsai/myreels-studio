import { compactNulls } from '../core/util.js';

export function analysisReviewMode(metadata) {
  const mode = String(metadata?.analysisReview || 'manual').trim().toLowerCase();
  return mode === 'auto' ? 'auto' : 'manual';
}

export function needsAnalysisConfirmation(metadata, args = {}) {
  return analysisReviewMode(metadata) === 'manual' && args?.confirmAnalysis !== true;
}

export function projectSettingsReady(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return !meta.harnessSettingsRequired || Boolean(meta.harnessSettingsCompletedAt);
}

export function analysisSettingsFromMetadata(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return compactNulls({
    shotDurationSeconds: Number(meta.scriptAnalyzerShotDurationSeconds ?? 30),
    maxShotsPerSegment: Number(meta.scriptAnalyzerMaxShotsPerSegment ?? 0),
    speechRate: Number(meta.scriptAnalyzerSpeechRate ?? 6),
    isDirectorScript: meta.scriptAnalyzerIsDirectorScript !== false,
    modelKey: String(meta.scriptAnalysisModelKey || ''),
    llmGroup: String(meta.scriptAnalyzerLlmGroup || ''),
    outputLanguage: String(meta.scriptAnalyzerOutputLanguage || 'zh'),
    aspectRatio: String(meta.scriptAnalyzerAspectRatio || meta.defaultVideoRatio || '9:16'),
    reviewMode: analysisReviewMode(meta),
  });
}

export function analysisSettingsText(settings) {
  const value = settings || {};
  return [
    `分镜时长上限=${value.shotDurationSeconds ?? 30}s`,
    `分镜内最多镜头数=${value.maxShotsPerSegment ?? 0}`,
    `台词语速=${value.speechRate ?? 6}`,
    `导演本=${value.isDirectorScript === false ? '否' : '是'}`,
    `分析模型=${value.llmGroup || value.modelKey || '(未指定)'}`,
    `输出语言=${value.outputLanguage || 'zh'}`,
    `画幅=${value.aspectRatio || '9:16'}`,
    `分析确认=${value.reviewMode === 'auto' ? '自动' : '人工'}`,
  ].join('；');
}
