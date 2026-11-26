import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PATH = join(homedir(), '.dsh', 'storages', 'myreels-studio', 'autonomy.json');

export const AUTONOMY_ITEMS = [
  { id: 'script_format_detect', label: '自动识别导演本/普通本', description: '按分镜标题、时间码、8 字段、【场】、人物行、△动作等特征自动判断剧本格式并选择分析模式。', default: true },
  { id: 'director_script_convert', label: '导演本自动转换与校验', description: '按导演本规则自动规范：分镜N｜mm:ss—mm:ss（X 秒）、编号连续、时间轴连续、时长不超过 15/30 秒、补齐 8 个字段，禁止 S01/Shot/镜头N 顶层。', default: true },
  { id: 'normal_script_convert', label: '普通本自动转换与校验', description: '按普通本规则自动规范：首行第N集、不含分镜/时间码/▲、【场】后紧跟人物行、△动作、角色台词，清理禁用生产标签和屏幕文字误写。', default: true },
  { id: 'script_fidelity_guard', label: '剧本优化保真校验', description: '转换/优化/改分镜后自动对比原剧本，检查台词、场景、人物是否被误改；发现丢失去重或回到原稿。', default: true },
  { id: 'analysis_blockers', label: '自动修复分析阻断项', description: '分析完成后自动处理可修复的 blocking 项；必要时重新分析或修正分镜。', default: true },
  { id: 'shot_prompt_optimize', label: '自动优化分镜提示词', description: '按 deliveryReview / shot audit 自动改写有问题的分镜提示词。', default: true },
  { id: 'shot_duration_fit', label: '分镜时长与台词匹配', description: '检查分镜时长、台词长度和动作节奏；台词在时长内说不完时自动调整提示词或建议拆镜，不擅自改剧情。', default: true },
  { id: 'asset_reference_audit', label: '自动审查资产素材引用', description: '对照剧本检查资产提示词、素材引用和参考图是否缺失或指向错误。', default: true },
  { id: 'asset_reference_repair', label: '自动补齐资产与参考图', description: '发现缺图、空变体或错误引用时，自动补主图、修引用并刷新预览。', default: true },
  { id: 'asset_prompt_repair', label: '自动修正资产提示词', description: '结合剧本给资产/变体提示词补齐缺失的外观、动作、场景、道具和负面约束，使用 assetfix 写回。', default: true },
  { id: 'preflight_gate', label: '生成前自动预检', description: '资产图/分镜视频下单前自动检查参考图、提示词、时长和预算，阻止明显错误。', default: true },
  { id: 'transient_retry', label: '传输失败自动重试', description: '分析器 R2/SSL、网络超时等暂时性失败自动重提，减少人工干预。', default: true },
  { id: 'auto_generation_retry', label: '生成失败自动重试', description: '资产图或分镜视频任务失败时自动重试一次，避免单次网络/排队失败中断整集。', default: true },
  { id: 'auto_render', label: '完成后自动渲染', description: '一集全部分镜完成后自动调用 render；缺镜只生成 .partial.mp4。', default: true },
  { id: 'auto_report', label: '自动生成报告', description: '阶段推进后自动生成本地 Markdown 报告，便于检查进度和成本。', default: true },
  { id: 'auto_preview', label: '自动刷新预览', description: '资产或分镜更新后自动生成本地预览页，方便检查参考图和分镜成片。', default: true },
  { id: 'duplicate_cleanup', label: '重复任务自动归档', description: '同一集出现多个 run 时自动归档旧的重复 run，不删除项目文件。', default: false },
  { id: 'visual_asset_check', label: '视觉资产一致性检查', description: '对资产图做视觉一致性抽查（需要视觉模型，可能增加耗时）。', default: false },
  { id: 'budget_fixed', label: '预算闸门（固定开启）', description: '生成前检查预算，超预算必须显式调整；此安全能力不允许关闭。', default: true, locked: true },
];

function normalize() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(PATH, 'utf8')) || {}; } catch {}
  const values = {};
  for (const item of AUTONOMY_ITEMS) {
    values[item.id] = item.locked ? true : (raw[item.id] === undefined ? item.default : raw[item.id] === true);
  }
  return values;
}

export function autonomyStatus() {
  const values = normalize();
  return {
    path: PATH,
    items: AUTONOMY_ITEMS.map((item) => ({ ...item, enabled: item.locked ? true : values[item.id] })),
  };
}

export function isAutonomyEnabled(id) {
  return normalize()[id] === true;
}

export function setAutonomy({ id, enabled, values }) {
  const current = normalize();
  if (values && typeof values === 'object') {
    for (const item of AUTONOMY_ITEMS) {
      if (item.locked) { current[item.id] = true; continue; }
      if (Object.prototype.hasOwnProperty.call(values, item.id)) current[item.id] = values[item.id] === true;
    }
  } else if (id) {
    const item = AUTONOMY_ITEMS.find((x) => x.id === id)
      || AUTONOMY_ITEMS.find((x) => x.label === id)
      || AUTONOMY_ITEMS.find((x) => x.label.includes(String(id)) || String(id).includes(x.label));
    if (!item) throw new Error(`unknown autonomy id: ${id}`);
    if (item.locked) throw new Error(`${id} is locked`);
    current[item.id] = enabled === true;
  }
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(current, null, 2), 'utf8');
  return autonomyStatus();
}
