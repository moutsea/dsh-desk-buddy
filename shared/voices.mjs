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
  completion: "做好啦！",
  idle: "陪我玩一会儿嘛。",
  preview: "嗯？嘿嘿，做好啦！",
});

export function isSoundVoice(value) {
  return SOUND_VOICES.some((voice) => voice.id === value);
}
