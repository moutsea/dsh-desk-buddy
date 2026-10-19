import { CHARACTER_LAYOUT } from "./character-layout.mjs";

export const PET_SIZE = { width: 300, height: 400 };
export const PET_CHARACTER = { width: 264, height: 270, top: 110 };
export const PET_SCALE = { min: 50, max: 150, step: 5, default: 100 };
export const CHAT_SIZES = {
  small: { label: "小", width: 360, height: 460 },
  medium: { label: "中", width: 480, height: 620 },
  large: { label: "大", width: 600, height: 760 },
};
export function normalizeChatSize(value) {
  return typeof value === "string" && Object.hasOwn(CHAT_SIZES, value)
    ? value
    : "small";
}
export function normalizePetScale(value) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return PET_SCALE.default;
  return Math.max(
    PET_SCALE.min,
    Math.min(
      PET_SCALE.max,
      Math.round(value / PET_SCALE.step) * PET_SCALE.step,
    ),
  );
}
export function petSize(value = PET_SCALE.default) {
  const scale = normalizePetScale(value) / 100;
  const baseline =
    (PET_CHARACTER.height * CHARACTER_LAYOUT.footY) / CHARACTER_LAYOUT.height;
  return {
    // Whole-pixel centers prevent repeated resize cycles from drifting sideways.
    width: Math.max(
      PET_SIZE.width,
      Math.ceil((PET_CHARACTER.width * scale + 36) / 2) * 2,
    ),
    height: Math.round(PET_SIZE.height + baseline * (scale - 1)),
  };
}
// Resize around the feet, preserving the character's screen center and baseline where space allows.
export function resizedPetAnchor(anchor, previous, next) {
  const before = petSize(previous),
    after = petSize(next);
  return {
    x: anchor.x + (before.width - after.width) / 2,
    y: anchor.y + before.height - after.height,
  };
}
export function desktopLayout(
  anchor,
  area,
  section = null,
  scale = PET_SCALE.default,
  chatSize = "small",
) {
  const size = petSize(scale);
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const x = clamp(anchor.x, area.x, area.x + area.width - size.width);
  const y = clamp(anchor.y, area.y, area.y + area.height - size.height);
  if (!section)
    return {
      bounds: { x, y, ...size },
      surface: {
        section: null,
        side: "left",
        pet: { x: 0, y: 0 },
        contentWidth: 0,
        contentHeight: 0,
        contentTop: 0,
      },
    };
  const gap = 18,
    left = x - area.x,
    right = area.x + area.width - x - size.width;
  const side = left >= right ? "left" : "right";
  const preferred =
    section === "chat"
      ? CHAT_SIZES[normalizeChatSize(chatSize)]
      : { width: 460, height: 720 };
  const contentWidth = Math.min(
    preferred.width,
    Math.max(320, Math.max(left, right) - gap),
    area.width - size.width - gap,
  );
  const contentHeight = Math.min(preferred.height, area.height);
  const width = size.width + gap + contentWidth,
    height = Math.max(contentHeight, size.height);
  const bx = clamp(
    side === "left" ? x - contentWidth - gap : x,
    area.x,
    area.x + area.width - width,
  );
  const by = clamp(
    y + size.height - height,
    area.y,
    area.y + area.height - height,
  );
  const petX = side === "left" ? contentWidth + gap : 0;
  return {
    bounds: {
      x: Math.round(bx),
      y: Math.round(by),
      width: Math.round(width),
      height,
    },
    surface: {
      section,
      side,
      pet: {
        x: Math.round(petX),
        y: Math.round(clamp(y - by, 0, height - size.height)),
      },
      contentWidth: Math.round(contentWidth),
      contentHeight,
      contentTop: height - contentHeight,
    },
  };
}
