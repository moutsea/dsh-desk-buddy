import { PET_CHARACTER } from "./desktop-layout.mjs";

export const DECK_LIMIT = 5;
const diagonal = Math.SQRT1_2;
// Stacked cards sit `offset` px apart in both axes: 22px leaves the rear card's
// heading strip readable while keeping five cards compact. One step of pointer
// travel along the diagonal is `offset * √2` long and browses one card.
const offset = 22;
const step = Math.round(offset * Math.SQRT2);
// Card box, the gap kept around the cards inside the stack box, the caption
// strip under the deck, and the widest card the deck allows.
const cardHeight = 98;
const padding = 8;
const captionHeight = 22;
const maxCardWidth = 244;
const cardInset = 12;
// The deck docks at most this far from the top of the window.
const dockOffset = 3;

/**
 * Where the stack box starts, relative to the pet stage. The deck stays inside
 * the window (`dockOffset`) unless the character leaves room for all of it.
 * @param {number} headroom Space between the window top and the pet, in px.
 * @param {number} height Stack height from `deckLayout`.
 * @returns {number}
 */
export function deckTop(headroom, height) {
  return Math.max(dockOffset - headroom, PET_CHARACTER.top - height);
}

/**
 * How many cards fit above the character. Cards and caption must stay above the
 * pet's head, otherwise the deck covers it and swallows clicks meant for the
 * character. A single card has no caption and never overlaps on its own.
 * @param {number} headroom Space between the window top and the pet, in px.
 * @returns {number}
 */
export function deckCapacity(headroom) {
  const budget = Math.max(0, headroom) + PET_CHARACTER.top - dockOffset;
  if (budget < cardHeight + padding * 2) return 1;
  const fit =
    Math.floor((budget - (cardHeight + padding * 2 + captionHeight)) / offset) +
    1;
  return Math.max(1, Math.min(DECK_LIMIT, fit));
}

/**
 * @param {number} count
 * @param {number} selected
 * @param {boolean} browsing
 * @param {number} [limit] Cards that fit on screen; defaults to `DECK_LIMIT`.
 * @returns {number[]}
 */
export function deckIndices(count, selected, browsing, limit = DECK_LIMIT) {
  if (!count) return [];
  selected = Math.max(0, Math.min(count - 1, selected));
  limit = Math.max(1, Math.min(DECK_LIMIT, limit));
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  if (browsing) {
    // End the window at the selected card so it keeps the front slot and the
    // deck does not jump when browsing starts.
    const start = Math.max(0, Math.min(count - limit, selected - limit + 1));
    return Array.from({ length: limit }, (_, index) => start + index);
  }
  // Keep the two ends and the selected session; the middle stays folded away.
  const visible = new Set([0, 1, count - 2, count - 1, selected]);
  for (let index = count - 3; visible.size < DECK_LIMIT; index--)
    visible.add(index);
  const indices = [...visible].sort((a, b) => a - b);
  if (indices.length <= limit) return indices;
  // Tight space: keep the selection and as much of the ends as still fit.
  const keep = [selected, count - 1, 0, count - 2, 1].filter((index) =>
    indices.includes(index),
  );
  return [...new Set(keep)].slice(0, limit).sort((a, b) => a - b);
}

// The selected card owns the front (lower-left) slot while the deck rests, so
// the painted stack keeps the same order as the hit targets. Browsing keeps
// list order instead, otherwise cards would jump under the pointer.
/**
 * @param {number[]} visible
 * @param {number} selected
 * @param {boolean} rotate
 * @returns {number[]}
 */
export function deckSlots(visible, selected, rotate) {
  if (!rotate || visible.at(-1) === selected) return visible;
  const rest = visible.filter((index) => index !== selected);
  return rest.length === visible.length ? visible : [...rest, selected];
}

/**
 * @param {number} count
 * @param {number} petWidth
 * @returns {{width: number, height: number, cardWidth: number,
 *   cardHeight: number, positions: {x: number, y: number}[]}}
 */
export function deckLayout(count, petWidth) {
  const stacked = count > 1;
  const width = stacked
    ? Math.min(maxCardWidth, petWidth - padding * 2 - offset * (DECK_LIMIT - 1))
    : petWidth - cardInset * 2;
  const displacement = stacked ? offset * (count - 1) : 0;
  return {
    width: width + displacement + padding * 2,
    height:
      cardHeight + displacement + padding * 2 + (stacked ? captionHeight : 0),
    cardWidth: width,
    cardHeight,
    // Rear cards extend to the upper right; cards and text stay horizontal.
    positions: Array.from({ length: count }, (_, index) => ({
      x: padding + offset * (count - 1 - index),
      y: padding + offset * index,
    })),
  };
}

/**
 * @param {{x: number, y: number, carry?: number} | null} previous
 * @param {{x: number, y: number}} point
 * @param {number} selected
 * @param {number} count
 * @returns {{pointer: {x: number, y: number, carry: number},
 *   selected: number}}
 */
export function moveDeckPointer(previous, point, selected, count) {
  const next = { x: point.x, y: point.y, carry: previous?.carry || 0 };
  if (!previous) return { pointer: next, selected };
  const dx = point.x - previous.x;
  const dy = point.y - previous.y;
  const along = (dy - dx) * diagonal;
  const across = (dx + dy) * diagonal;
  // Browse along the stacking diagonal, ignoring perpendicular motion.
  if (Math.abs(across) > Math.abs(along) * 1.5) next.carry = 0;
  else next.carry += along;
  const steps = Math.trunc(next.carry / step);
  const index = Math.max(0, Math.min(count - 1, selected + steps));
  next.carry = index === selected && steps ? 0 : next.carry - steps * step;
  return { pointer: next, selected: index };
}
