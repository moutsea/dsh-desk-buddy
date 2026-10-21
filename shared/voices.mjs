export const SOUND_VOICES = Object.freeze([
  { id: "qiaoxiaojiao_v3.1", name: "俏皮少女", style: "俏丽可爱" },
  { id: "longanlingxi_v3.1", name: "软萌甜心", style: "软萌甜美" },
  { id: "anyuqing_v3.1", name: "元气甜妹", style: "明亮甜妹" },
  { id: "anxiaolan_v3.1", name: "清甜纯净", style: "清甜纯净" },
  { id: "wenhuaiqing_v3.1", name: "轻柔治愈", style: "清亮柔和" },
  { id: "xuxiaoqiao_v3.1", name: "灵动自然", style: "自然俏皮" },
  { id: "yeqinghe_v3.1", name: "温柔邻家", style: "亲切温柔" },
  { id: "anruorou_v3.1", name: "轻柔气声", style: "轻柔气声" },
]);

export const DEFAULT_SOUND_VOICE = SOUND_VOICES[0].id;
export const SOUND_PHRASES = Object.freeze({
  pet: "嗯？嘿嘿。",
  angry: "慢一点啦，哼！",
  completion: "做好啦！",
  idle: "陪我玩一会儿嘛。",
  started: "收到，交给我吧。",
  attention: "需要你看一下哦。",
  failure: "遇到一点问题，来看看嘛。",
  started_2: "好呀，我这就开始。",
  started_3: "嗯，我来处理啦。",
  completion_2: "完成啦，来看看吧。",
  completion_3: "这件事办好啦。",
  attention_2: "这里要请你确认一下。",
  attention_3: "等你回应一下哦。",
  failure_2: "这次没完成，来看看原因吧。",
  failure_3: "出了点小状况，我们看看吧。",
  shy: "一直看着我做什么呀……",
  wake: "唔……我醒啦。",
  sleep: "有点困了，我眯一会儿哦。",
  welcome: "你回来啦，我在呢。",
  moved: "这里也不错嘛。",
  reconnected: "又连上啦。",
  pet_2: "我在呢。",
  pet_3: "嘿嘿，怎么啦？",
  idle_2: "要不要休息一下呀？",
  idle_3: "我就在这里陪着你。",
  preview: "嗯？嘿嘿，做好啦！",
});

export const SOUND_VARIANTS = Object.freeze({
  pet: ["pet", "pet_2", "pet_3"],
  idle: ["idle", "idle_2", "idle_3"],
  started: ["started", "started_2", "started_3"],
  completion: ["completion", "completion_2", "completion_3"],
  attention: ["attention", "attention_2", "attention_3"],
  failure: ["failure", "failure_2", "failure_3"],
});

export function isSoundVoice(value) {
  return SOUND_VOICES.some((voice) => voice.id === value);
}
