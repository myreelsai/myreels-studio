export const PLUGIN_ID = 'myreels-studio';
export const DEFAULT_API = 'https://api.myreels.tv';

export const DEFAULTS = {
  // 统一环境地址：切换测试/生产只改这一项
  baseUrl: '',
  apiBaseUrl: DEFAULT_API,
  webBaseUrl: 'https://myreels.tv',
  authBaseUrl: '',
  publicApiKey: '',
  genBaseUrl: DEFAULT_API,
  mediaHost: 'https://image.myreels.tv',
  imageModel: 'GPT Image 2 LCC',
  imageModelSlug: 'pr-d2a95e26',
  videoModel: 'MyReels Pro (sd 2.0 4-8折)',
  videoModelSlug: 'myreels-vega',
  videoLongModel: 'MyReels Pro (sd 2.5 7.5折)',
  videoLongModelSlug: 'wand-vega-video-1.5-pro',
  videoLongThresholdSec: 15,
  defaultAspect: '9:16',
  ratios: {
    character: '16:9',
    scene: '16:9',
    image: '16:9',
    video: '16:9',
    item: '1:1',
    creature: '1:1',
  },
  unitCost: { image: 14, video: 116, videoLong: 564 },
  render: { width: 1080, height: 1920, fps: 30 },
};

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function resolveConfig(config) {
  const raw = isObject(config) ? config : {};
  const trim = (v) => String(v || '').trim().replace(/\/+$/, '');
  const base = trim(raw.baseUrl);
  const apiBaseUrl = base || trim(raw.apiBaseUrl) || DEFAULT_API;
  const authBaseUrl = base || trim(raw.authBaseUrl) || apiBaseUrl;
  const genBaseUrl = base || trim(raw.genBaseUrl) || apiBaseUrl;
  return {
    ...DEFAULTS,
    ...raw,
    baseUrl: base,
    apiBaseUrl,
    authBaseUrl,
    genBaseUrl,
    ratios: { ...DEFAULTS.ratios, ...(isObject(raw.ratios) ? raw.ratios : {}) },
    unitCost: { ...DEFAULTS.unitCost, ...(isObject(raw.unitCost) ? raw.unitCost : {}) },
    render: { ...DEFAULTS.render, ...(isObject(raw.render) ? raw.render : {}) },
  };
}

export function configOf(config) {
  return resolveConfig(config);
}
