import { compileShotPrompt } from './prompt.js';

const RATIO_FIELD_CANDIDATES = ['aspect_ratio', 'ratio', 'aspectRatio', 'image_aspect_ratio', 'output_aspect_ratio'];
const DURATION_FIELD_CANDIDATES = ['duration', 'duration_seconds', 'target_duration_seconds', 'end_seconds', 'max_clip_seconds'];
const IMAGE_FIELD_CANDIDATES = ['images', 'reference_images', 'image1', 'image2'];
const DEFAULT_FIELD_CANDIDATES = ['resolution', 'seed', 'sound', 'auto_compliance'];

function schemaHas(schema, key) {
  return Boolean(schema && typeof schema === 'object' && Object.prototype.hasOwnProperty.call(schema, key));
}

function setSchemaDefaultFields(userInput, schema) {
  for (const key of DEFAULT_FIELD_CANDIDATES) {
    if (!schemaHas(schema, key)) continue;
    const field = schema[key];
    if (field && typeof field === 'object' && Object.prototype.hasOwnProperty.call(field, 'default')) {
      userInput[key] = field.default;
    }
  }
}

function setSchemaRatio(userInput, schema, ratio) {
  if (!ratio) return;
  const keys = RATIO_FIELD_CANDIDATES.filter((key) => schemaHas(schema, key));
  for (const key of keys.length ? keys : ['aspect_ratio']) userInput[key] = ratio;
}

function setSchemaDuration(userInput, schema, duration) {
  const value = Number(duration);
  if (!Number.isFinite(value) || value <= 0) return;
  const keys = DURATION_FIELD_CANDIDATES.filter((key) => schemaHas(schema, key));
  if (!keys.length) {
    userInput.duration = value;
    return;
  }
  for (const key of keys) {
    if (key === 'end_seconds' || key === 'max_clip_seconds') userInput[key] = value;
    else userInput[key] = value;
  }
  if (keys.includes('end_seconds') && schemaHas(schema, 'start_seconds')) userInput.start_seconds = 0;
}

function setSchemaImages(userInput, schema, images) {
  if (!Array.isArray(images) || !images.length) return;
  const keys = IMAGE_FIELD_CANDIDATES.filter((key) => schemaHas(schema, key));
  if (!keys.length) {
    userInput.images = images;
    return;
  }
  if (keys.includes('images')) userInput.images = images;
  else if (keys.includes('reference_images')) userInput.reference_images = images;
  if (keys.includes('image1')) userInput.image1 = images[0];
  if (keys.includes('image2') && images[1]) userInput.image2 = images[1];
}

function setVideoPromptOptimize(userInput, schema) {
  if (!schemaHas(schema, 'optimizePrompt')) return;
  const options = Array.isArray(schema.optimizePrompt?.options) ? schema.optimizePrompt.options : [];
  const auto = options.find((option) => {
    const value = String(option?.value || '');
    const label = String(option?.label || '');
    return value === 'h3_video' || /auto/i.test(value) || /自动/.test(label);
  });
  if (auto) userInput.optimizePrompt = auto.value;
}

function buildBaseUserInput(schema, { prompt, images, ratio, duration }) {
  const userInput = { prompt, sound: 'on' };
  setSchemaDefaultFields(userInput, schema);
  setSchemaRatio(userInput, schema, ratio);
  setSchemaDuration(userInput, schema, duration);
  setSchemaImages(userInput, schema, images);
  return userInput;
}

export function buildShotVideoItemFromParts(shot, prompt, images, cfg, duration) {
  const ratio = String(cfg.defaultAspect || '');
  const schema = cfg.videoSchema || null;
  const userInput = buildBaseUserInput(schema, { prompt, images, ratio, duration });
  setVideoPromptOptimize(userInput, schema);
  const ratioInputs = ratio
    ? { ratio, aspectRatio: ratio, aspect_ratio: ratio, image_aspect_ratio: ratio, output_aspect_ratio: ratio }
    : {};
  return {
    shotId: shot.id,
    userInput,
    finalParameters: {
      menu: 'video',
      ...ratioInputs,
      outputType: 'video',
      targetType: 'shot_video',
      ...(Number(duration) > 0 ? { duration: Number(duration) } : {}),
    },
  };
}

export function buildShotVideoItem(shot, refMap, cfg, duration) {
  const { prompt, images } = compileShotPrompt(shot.prompt || shot.description, refMap);
  return buildShotVideoItemFromParts(shot, prompt, images, cfg, duration);
}

export function buildShotVideoTaskConfig(videoTool, cfg) {
  const ratio = String(cfg.defaultAspect || '');
  const ratioInputs = ratio
    ? { ratio, aspectRatio: ratio, aspect_ratio: ratio, image_aspect_ratio: ratio, output_aspect_ratio: ratio }
    : {};
  const userInput = buildBaseUserInput(videoTool?.userInputSchema || null, { ratio });
  setVideoPromptOptimize(userInput, videoTool?.userInputSchema || null);
  return {
    serviceId: videoTool.serviceId,
    promptResourceId: videoTool.id,
    taskType: 'video',
    promptField: 'prompt',
    userInput,
    finalParameters: {
      menu: 'video',
      model: cfg.videoModel,
      ...ratioInputs,
      modelId: videoTool.id,
      modelSlug: videoTool.slug,
      serviceId: videoTool.serviceId,
      serviceName: 'Seedance 自动合规网关',
      deployment: 'tv',
      outputType: 'video',
      targetType: 'shot_video',
      s3TargetRef: 'userStorageOss',
      source: 'story_workbench_auto_video',
    },
  };
}
