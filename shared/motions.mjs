import { characterPose } from "./character-layout.mjs";
// Frame indices read left-to-right, then top-to-bottom in a 2×2 sheet.
export const MOTIONS = {
  idle: {
    label: "挥手眨眼",
    sequence: [
      [0, 2200],
      [1, 110],
      [2, 110],
      [3, 150],
      [0, 1300],
    ],
  },
  blink: {
    label: "轻轻眨眼",
    sequence: [
      [0, 1500],
      [1, 130],
      [2, 100],
      [3, 160],
    ],
  },
  happy: {
    label: "开心笑起来",
    sequence: [
      [0, 900],
      [1, 180],
      [2, 280],
      [3, 200],
    ],
  },
  shy: {
    label: "害羞低头",
    sequence: [
      [0, 1000],
      [1, 300],
      [2, 450],
      [3, 300],
    ],
  },
  angry: {
    label: "鼓脸轻哼",
    sequence: [
      [0, 1100],
      [1, 160],
      [2, 240],
      [3, 160],
    ],
  },
  sad: {
    label: "委屈眨眼",
    sequence: [
      [0, 1400],
      [1, 180],
      [2, 300],
      [3, 250],
    ],
  },
  surprised: {
    label: "吓一跳",
    sequence: [
      [0, 650],
      [1, 160],
      [2, 230],
      [3, 600],
    ],
  },
  confused: {
    label: "歪头想一想",
    sequence: [
      [0, 1200],
      [1, 280],
      [2, 500],
      [3, 280],
    ],
  },
  love: {
    label: "比心眨眼",
    sequence: [
      [0, 1000],
      [1, 180],
      [2, 300],
      [3, 220],
    ],
  },
  cheer: {
    label: "挥拳加油",
    sequence: [
      [0, 450],
      [1, 180],
      [2, 350],
      [3, 180],
    ],
  },
  proud: {
    label: "得意点头",
    sequence: [
      [0, 1200],
      [1, 220],
      [2, 350],
      [3, 220],
    ],
  },
  celebrating: {
    label: "举手欢呼",
    sequence: [
      [0, 450],
      [1, 200],
      [2, 350],
      [3, 200],
    ],
  },
  thinking: {
    label: "托腮思考",
    sequence: [
      [0, 1700],
      [1, 250],
      [2, 350],
      [3, 250],
    ],
  },
  working: {
    label: "认真敲键盘",
    sequence: [
      [0, 220],
      [1, 220],
      [0, 220],
      [1, 220],
      [0, 220],
      [1, 220],
      [2, 120],
      [3, 180],
    ],
  },
  learning: {
    label: "读书翻页",
    sequence: [
      [0, 1600],
      [1, 240],
      [2, 300],
      [3, 500],
    ],
  },
  bored: {
    label: "托脸叹气",
    sequence: [
      [0, 1600],
      [1, 300],
      [2, 500],
      [3, 350],
    ],
  },
  rice: {
    label: "吃一口饭",
    sequence: [
      [0, 900],
      [1, 280],
      [2, 450],
      [3, 280],
    ],
  },
  sleepy: {
    label: "打个哈欠",
    sequence: [
      [0, 1400],
      [1, 350],
      [2, 600],
      [3, 350],
    ],
  },
  sleeping: {
    label: "睡着轻呼吸",
    sequence: [
      [0, 1200],
      [1, 700],
      [2, 1000],
      [3, 700],
    ],
  },
};

export function motionDuration(id) {
  return MOTIONS[id]?.sequence.reduce((sum, [, ms]) => sum + ms, 0) || 0;
}

/** SVG image transforms use native coordinates; alpha-derived crops exclude neighboring cells.
 * @param {any} registration */
export function motionKeyframes(id, width, height, registration = null) {
  const motion = MOTIONS[id];
  if (
    !motion ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return [];
  const total = motionDuration(id);
  let elapsed = 0;
  const pose = (index) => {
    const x = ((index % 2) * width) / 2,
      y = (Math.floor(index / 2) * height) / 2;
    const box = registration?.frames[index];
    return {
      transform:
        box?.bodyTop !== undefined
          ? characterPose(box, x, y).transform
          : `translate(${-x + (box?.dx || 0)}px, ${-y + (box?.dy || 0)}px)`,
      clipPath: box?.outline?.length
        ? `polygon(${box.outline.map(([px, py]) => `${x + px}px ${y + py}px`).join(", ")})`
        : box
          ? `polygon(${x + box.left}px ${y + box.top}px, ${x + box.right}px ${y + box.top}px, ${x + box.right}px ${y + box.bottom}px, ${x + box.left}px ${y + box.bottom}px)`
          : "none",
    };
  };
  const frames = motion.sequence.map(([index, ms]) => {
    const frame = {
      ...pose(index),
      offset: elapsed / total,
      easing: "steps(1, end)",
    };
    elapsed += ms;
    return frame;
  });
  return [
    ...frames,
    {
      ...pose(motion.sequence[0][0]),
      offset: 1,
      easing: "steps(1, end)",
    },
  ];
}
