/**
 * 内置默认敏感词表
 *
 * 来源 = 分析 Runway SAFETY.INPUT.THIRD_PARTY 高频触发词 + 通用 GenAI 内容政策
 * 用户可以在设置页增删，不影响这里的默认列表（按类别 merge）
 *
 * 注意：这只是"第一道门禁"，无法保证 Runway 一定接受。目的是：
 *   1. 帮用户省掉明显会被拒的请求（省 credit）
 *   2. 给出改写建议让用户自己决定
 */

export const DEFAULT_WORDS = {
  // 色情/暴露
  nsfw: [
    '裸体', '赤身', '色情', '黄色', '情色', '性感', '三点', '露点',
    'nude', 'naked', 'porn', 'nsfw', 'explicit', 'sexual', 'erotic'
  ],

  // 暴力/血腥
  violence: [
    '血腥', '杀戮', '屠杀', '尸体', '断肢', '自残', '自杀', '爆头', '斩首',
    'blood', 'gore', 'kill', 'murder', 'corpse', 'decapitat', 'mutilat', 'suicide'
  ],

  // 政治/敏感人物（示意，实际落地按业务需求）
  political: [
    '习近平', '毛泽东', '天安门', '六四', '法轮功',
    'Xi Jinping', 'Mao Zedong', 'Tiananmen', 'Falun Gong', 'Taiwan independence'
  ],

  // 知名真人（第三方 moderation 对名人识别最敏感，第一批触发源）
  celebrity: [
    '马斯克', '乔布斯', '特朗普', '拜登', '奥巴马', '普京', '泰勒斯威夫特', '霉霉', '碧昂斯',
    'Elon Musk', 'Steve Jobs', 'Donald Trump', 'Joe Biden', 'Barack Obama', 'Vladimir Putin',
    'Taylor Swift', 'Beyonce', 'Kim Kardashian', 'Tom Cruise', 'Leonardo DiCaprio'
  ],

  // 品牌 Logo（容易触发版权/moderation）
  brand: [
    '可口可乐', '百事', '耐克', '阿迪达斯', '苹果手机', '特斯拉',
    'Coca-Cola', 'Pepsi', 'Nike', 'Adidas', 'Apple iPhone', 'Tesla', 'Disney', 'Marvel', 'Pokemon'
  ]
};

export const CATEGORY_LABEL = {
  nsfw: '色情/暴露',
  violence: '暴力/血腥',
  political: '政治敏感',
  celebrity: '真人名人',
  brand: '品牌名',
  custom: '自定义'
};

export const CATEGORY_ADVICE = {
  nsfw: '此类内容会被 Runway 直接拒绝。请改用含蓄表达或移除。',
  violence: '建议弱化动作描述（如"打斗"→"对峙"），避免血腥后果细节。',
  political: '避免具体人名/事件；用泛化表达（如"政治家"而非具体姓名）。',
  celebrity: '第三方审核对名人非常敏感。请改为泛化描述（如"摇滚明星"而非具体姓名）。',
  brand: '品牌 Logo 易触发版权审核。建议用通用描述替代（如"运动鞋"而非"Nike 球鞋"）。',
  custom: '自定义敏感词命中。'
};
