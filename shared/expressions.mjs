export const EXPRESSIONS = [
  {
    id: "idle",
    label: "待机",
    group: "日常心情",
    description: "挥挥手，随时陪着你",
  },
  {
    id: "blink",
    label: "眨眼",
    group: "日常心情",
    description: "闭上眼睛，安静一瞬",
  },
  {
    id: "happy",
    label: "开心",
    group: "日常心情",
    description: "事情做好啦，笑一个",
  },
  {
    id: "shy",
    label: "害羞",
    group: "日常心情",
    description: "被你看得有一点脸红",
  },
  {
    id: "angry",
    label: "生气",
    group: "日常心情",
    description: "抱起手臂，轻轻哼一声",
  },
  {
    id: "sad",
    label: "委屈",
    group: "日常心情",
    description: "眼泪汪汪，等你安慰",
  },
  {
    id: "surprised",
    label: "震惊",
    group: "日常心情",
    description: "咦，居然会这样",
  },
  {
    id: "confused",
    label: "疑问",
    group: "日常心情",
    description: "歪歪头，想听你的回答",
  },
  {
    id: "love",
    label: "比心",
    group: "陪伴互动",
    description: "悄悄给你比一个心",
  },
  {
    id: "cheer",
    label: "加油",
    group: "陪伴互动",
    description: "握起小拳头，为你打气",
  },
  {
    id: "proud",
    label: "得意",
    group: "陪伴互动",
    description: "叉着腰，这次做得不错吧",
  },
  {
    id: "celebrating",
    label: "庆祝",
    group: "陪伴互动",
    description: "完成啦，举起双手庆祝",
  },
  {
    id: "thinking",
    label: "思考",
    group: "工作与生活",
    description: "托着下巴，认真想一想",
  },
  {
    id: "working",
    label: "工作",
    group: "工作与生活",
    description: "拿出电脑，认真开工",
  },
  {
    id: "learning",
    label: "学习",
    group: "工作与生活",
    description: "翻开书本，认真读资料",
  },
  {
    id: "bored",
    label: "无聊",
    group: "工作与生活",
    description: "托着脸，等你找我玩",
  },
  {
    id: "rice",
    label: "吃白饭",
    group: "工作与生活",
    description: "先吃一口，补充算力",
  },
  {
    id: "sleepy",
    label: "困困",
    group: "工作与生活",
    description: "打个小哈欠，眼皮有点重",
  },
  {
    id: "sleeping",
    label: "睡觉",
    group: "工作与生活",
    description: "闭上眼睛，休息一下",
  },
];
const ids = new Set(EXPRESSIONS.map((expression) => expression.id));
export function isExpressionId(value) {
  return typeof value === "string" && ids.has(value);
}
export function expressionForMood(mood) {
  const mapping = {
    idle: "idle",
    thinking: "thinking",
    tool: "working",
    working: "working",
    learning: "learning",
    replying: "happy",
    celebrating: "celebrating",
    waiting: "confused",
    done: "happy",
    petted: "love",
    error: "surprised",
    shocked: "surprised",
    concerned: "sad",
    blocked: "confused",
    cancelled: "sleepy",
    offline: "sleeping",
  };
  return Object.hasOwn(mapping, mood)
    ? mapping[mood]
    : isExpressionId(mood)
      ? mood
      : "idle";
}
/** @param {{selection?: string, taskMood?: string, interaction?: {id: string, until: number} | null, idleExpression?: string, now?: number}} options */
export function chooseExpression({
  selection = "auto",
  taskMood = "idle",
  interaction = null,
  idleExpression = "idle",
  now = Date.now(),
}) {
  if (isExpressionId(selection)) return selection;
  if (!["idle", "done"].includes(taskMood)) return expressionForMood(taskMood);
  if (interaction && interaction.until > now && isExpressionId(interaction.id))
    return interaction.id;
  if (taskMood === "done") return "happy";
  return isExpressionId(idleExpression) ? idleExpression : "idle";
}
