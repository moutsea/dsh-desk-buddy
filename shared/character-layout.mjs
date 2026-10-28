export const CHARACTER_LAYOUT = {
  width: 1000,
  height: 1200,
  figureHeight: 1100,
  footX: 500,
  footY: 1160,
};

/** Normalize the visible figure, not the transparent canvas or pose width.
 * @param {any} box */
export function characterPose(box, sourceX = 0, sourceY = 0) {
  if (
    !box ||
    !Number.isFinite(box.footY - box.bodyTop) ||
    box.footY <= box.bodyTop
  )
    return {
      scale: 1,
      x: -sourceX,
      y: -sourceY,
      transform: `translate(${-sourceX}px, ${-sourceY}px)`,
    };
  const scale = CHARACTER_LAYOUT.figureHeight / (box.footY - box.bodyTop);
  const x = CHARACTER_LAYOUT.footX - (sourceX + box.footX) * scale;
  const y = CHARACTER_LAYOUT.footY - (sourceY + box.footY) * scale;
  return {
    scale,
    x,
    y,
    transform: `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`,
  };
}

/** Scale every measurement in a registration tree to a resized source image.
 * @param {any} value @param {number} scale @returns {any} */
export function scaleRegistration(value, scale) {
  if (Array.isArray(value))
    return value.map((item) => scaleRegistration(item, scale));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scaleRegistration(item, scale),
      ]),
    );
  return typeof value === "number" ? value * scale : value;
}
