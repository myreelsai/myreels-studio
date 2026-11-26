/**
 * 内置生成规则（知识库）。kind=code 由 preflight 机械检查；kind=manual 交给 Agent 视觉/语义判断。
 * 数字尽量来自模型 schema；这里只写"检查什么、什么级别、为什么"。
 */
export const BUILTIN_RULES = [
  { id: 'model.exists', scope: 'run', kind: 'code', check: 'modelExists', level: 'error', message: '所选模型在工具目录中不存在', source: 'GET /tools' },
  { id: 'video.refs.maxFiles', scope: 'shot', kind: 'code', check: 'refMaxFiles', level: 'error', message: '分镜参考图数量超过模型上限', source: 'userInputSchema.images.maxFiles' },
  { id: 'video.prompt.maxLength', scope: 'shot', kind: 'code', check: 'promptMaxLength', level: 'error', message: '分镜提示词超过模型上限，会被截断或拒单', source: 'userInputSchema.prompt.maxLength' },
  { id: 'video.duration.cap', scope: 'shot', kind: 'code', check: 'durationCap', level: 'info', message: '分镜时长超过单段上限，需要多段生成', source: 'userInputSchema.duration.options' },
  { id: 'shot.beats.density', scope: 'shot', kind: 'code', check: 'beatsDensity', level: 'warn', message: '时间切点过密，30s 单镜建议 ≤12 拍、15s 建议 ≤6 拍', source: 'generation contract' },
  { id: 'shot.refs.recommended', scope: 'shot', kind: 'code', check: 'refsRecommended', level: 'warn', message: '参考图建议 ≤4 张，过多会串角色', source: 'generation contract' },
  { id: 'shot.prop.blocking', scope: 'shot', kind: 'code', check: 'propBlocking', level: 'warn', message: '道具缺持有者/手部/朝向描述，容易穿帮', source: 'generation contract' },
  { id: 'shot.action.decompose', scope: 'shot', kind: 'code', check: 'actionDecompose', level: 'warn', message: '穿衣/披衣/递物需分解为连续动作', source: 'generation contract' },
  { id: 'shot.subtitle.policy', scope: 'shot', kind: 'code', check: 'subtitlePolicy', level: 'warn', message: '未声明无字幕/无文字，模型可能烧字幕', source: 'generation contract' },
  { id: 'shot.continuity.lock', scope: 'shot', kind: 'code', check: 'continuityLock', level: 'warn', message: '缺少同一张脸/同一件服装/无眼镜的连续性锁定', source: 'generation contract' },
  { id: 'ref.tag.missing', scope: 'shot', kind: 'code', check: 'refMissing', level: 'error', message: '参考图标签指向的资产/变体不存在', source: 'story prompt 标签校验' },
  { id: 'ref.variant.noImage', scope: 'shot', kind: 'code', check: 'refVariantNoImage', level: 'error', message: '标签点名的变体没有图', source: 'story asset variants' },
  { id: 'ref.asset.fallback', scope: 'shot', kind: 'code', check: 'refAssetFallback', level: 'warn', message: '标签匹配不到变体，会退化为资产首选图（可能错图）', source: 'story prompt 标签校验' },
  { id: 'variant.prompt.missing', scope: 'variant', kind: 'code', check: 'variantNoPrompt', level: 'error', message: '变体缺少 prompt/description，生成无内容', source: 'story asset variants' },
  { id: 'variant.prompt.maxLength', scope: 'variant', kind: 'code', check: 'variantPromptMaxLength', level: 'error', message: '变体提示词超过图片模型上限', source: 'userInputSchema.prompt.maxLength' },
  { id: 'variant.name.missing', scope: 'variant', kind: 'code', check: 'variantNameMissing', level: 'warn', message: '变体提示词未出现资产名/别名（造型变体除外）', source: 'story asset variants' },
  { id: 'variant.image.missing', scope: 'variant', kind: 'code', check: 'variantNoImage', level: 'info', message: '变体还没有图，可生成', source: 'story asset variants' },
  { id: 'budget.exhausted', scope: 'run', kind: 'code', check: 'budgetExhausted', level: 'warn', message: '预算已用满，继续生成会被闸门拦截', source: 'state.settings.budgetPoints' },

  { id: 'character.identity', scope: 'variant', kind: 'manual', level: 'warn', message: '角色脸型/发型/年龄/气质与设定图一致', source: 'Harness 视觉' },
  { id: 'character.costume', scope: 'variant', kind: 'manual', level: 'warn', message: '服装/配饰与该造型描述一致', source: 'Harness 视觉' },
  { id: 'scene.consistency', scope: 'variant', kind: 'manual', level: 'warn', message: '场景空间结构与风格符合剧本', source: 'Harness 视觉' },
  { id: 'item.readability', scope: 'variant', kind: 'manual', level: 'warn', message: '道具/文字/印章内容清晰可读、无乱码', source: 'Harness 视觉' },
  { id: 'shot.continuity', scope: 'shot', kind: 'manual', level: 'warn', message: '相邻分镜角色外观/服装/场景连贯', source: 'Harness 视觉' },
  { id: 'shot.prompt.clarity', scope: 'shot', kind: 'manual', level: 'info', message: '动作/台词/镜头语言无自相矛盾或歧义', source: 'Agent 阅读' },
  { id: 'video.no-watermark', scope: 'shot', kind: 'manual', level: 'warn', message: '画面无平台水印、无多余文字', source: 'Harness 视觉' },
];
