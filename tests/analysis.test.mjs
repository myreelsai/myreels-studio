import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisReviewMode,
  analysisSettingsFromMetadata,
  analysisSettingsText,
  needsAnalysisConfirmation,
  projectSettingsReady,
} from '../lib/story/analysis.js';
import { buildAnalyzeRequest } from '../lib/story/client.js';

test('剧本分析默认人工确认，auto 或显式 confirm 才直接提交', () => {
  assert.equal(analysisReviewMode({}), 'manual');
  assert.equal(needsAnalysisConfirmation({}), true);
  assert.equal(needsAnalysisConfirmation({}, { confirmAnalysis: true }), false);
  assert.equal(needsAnalysisConfirmation({ analysisReview: 'auto' }), false);
  assert.equal(needsAnalysisConfirmation({ analysisReview: 'auto' }, { confirmAnalysis: false }), false);
});

test('分析请求强制单集范围，不允许 1-x 批量范围', () => {
  const body = buildAnalyzeRequest({
    text: '剧本',
    stylePrompt: '',
    mode: 'director_storyboard',
    episodeNo: 7,
    analysis: { shotDurationSeconds: 30, llmGroup: 'group2' },
  });
  assert.deepEqual(body.finalParameters.episode_range, [7, 7]);
  assert.equal(body.shot_duration_seconds, 30);
  assert.equal(body.llm_group, 'group2');
  assert.throws(
    () => buildAnalyzeRequest({ text: '剧本', mode: 'director_storyboard', episodeNo: 0 }),
    /单个集号/
  );
});

test('新项目必须先保存项目设置，旧项目无需该标记', () => {
  assert.equal(projectSettingsReady({}), true);
  assert.equal(projectSettingsReady({ harnessSettingsRequired: true }), false);
  assert.equal(projectSettingsReady({ harnessSettingsRequired: true, harnessSettingsCompletedAt: 'now' }), true);
});

test('项目分析参数映射到提交字段', () => {
  const settings = analysisSettingsFromMetadata({
    scriptAnalyzerShotDurationSeconds: 30,
    scriptAnalyzerMaxShotsPerSegment: 0,
    scriptAnalyzerSpeechRate: 6,
    scriptAnalyzerIsDirectorScript: true,
    scriptAnalysisModelKey: 'deepseek-v4.1',
    scriptAnalyzerLlmGroup: 'group2',
    scriptAnalyzerOutputLanguage: 'ja',
    scriptAnalyzerAspectRatio: '9:16',
    analysisReview: 'manual',
  });
  assert.equal(settings.shotDurationSeconds, 30);
  assert.equal(settings.maxShotsPerSegment, 0);
  assert.equal(settings.speechRate, 6);
  assert.equal(settings.isDirectorScript, true);
  assert.equal(settings.modelKey, 'deepseek-v4.1');
  assert.equal(settings.llmGroup, 'group2');
  assert.equal(settings.outputLanguage, 'ja');
  assert.equal(settings.aspectRatio, '9:16');
  assert.match(analysisSettingsText(settings), /人工/);
});
