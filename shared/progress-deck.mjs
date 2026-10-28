import { PET_CHARACTER } from "./desktop-layout.mjs";

export const DECK_LIMIT = 5;
// Stacked cards sit `offset` px apart in both axes: 22px leaves the rear card's
// heading strip readable while keeping five cards compact.
const offset = 22;
// Card box, the gap kept around the cards inside the stack box, the caption
// strip under the deck, and the widest card the deck allows.
const cardHeight = 98;
const padding = 8;
const captionHeight = 22;
const maxCardWidth = 244;
const cardInset = 12;
// The deck docks at most this far from the top of the window.
const dockOffset = 3;

/** Keep streaming updates stable; promote finished work only between browsing.
 * @param {{order: string[], completed: Record<string, number>, automatic?: string}} previous
 * @param {{sessionId: string, completedAt?: number}[]} items
 * @param {boolean} browsing
 */
export function reconcileDeckOrder(previous, items, browsing) {
  const incoming = items.map((item) => item.sessionId).reverse();
  const order = [
    ...previous.order.filter((id) => incoming.includes(id)),
    ...incoming.filter((id) => !previous.order.includes(id)),
  ];
  if (browsing)
    return {
      order,
      completed: previous.completed,
      automatic: previous.automatic,
      promoted: undefined,
    };
  const completed = Object.fromEntries(
    items
      .filter((item) => (item.completedAt ?? 0) > 0)
      .map((item) => [item.sessionId, item.completedAt || 0]),
  );
  // The last slot is the front of the stack.
  order.sort((a, b) => (completed[a] || 0) - (completed[b] || 0));
  const newestFirst = [...order].reverse();
  const newCompletion = newestFirst.some(
    (id) => completed[id] && completed[id] !== previous.completed[id],
  );
  const lostAutomatic = previous.automatic && !completed[previous.automatic];
  // A restarted auto-selected card must release the front slot in large decks.
  // Manual selections clear `automatic` and remain under the user's control.
  const promoted =
    newCompletion || lostAutomatic
      ? newestFirst.find((id) => completed[id])
      : undefined;
  const automatic =
    promoted ?? (lostAutomatic ? undefined : previous.automatic);
  return { order, completed, automatic, promoted };
}

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
    // Prefer the preceding neighbours; deckSlots keeps the selected card in
    // front even when this window hits the beginning of the list.
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

// Large decks keep the selected card in the front (lower-left) slot both at
// rest and while browsing, so keyboard browsing never moves the pointer's
// click/close targets. Small decks keep list order: every card already fits and
// a pointer hover must not restack the deck at all.
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
 * @typedef {{slots: (string | null)[], active: string, hovered: boolean,
 *   capacity: number, width: number, headroom: number, rotate: boolean}} DeckView
 */

/** Keep pointer targets in place while sessions join or leave a hovered deck.
 * The frame stays fixed until pointer exit; any extra cards remain reachable
 * by rotation. Empty slots preserve geometry when a visible card disappears.
 * @param {DeckView | undefined} previous Last committed presentation.
 * @param {{ids: string[], active: string, hovered: boolean, browsing: boolean,
 *   capacity: number, width: number, headroom: number}} current
 * @returns {DeckView}
 */
export function reconcileDeckView(previous, current) {
  const { ids, active, hovered, browsing, capacity, width, headroom } = current;
  const preserve =
    previous?.hovered &&
    hovered &&
    previous.capacity === capacity &&
    previous.width === width &&
    previous.headroom === headroom &&
    previous.slots.length > 0 &&
    ids.length > 0;
  const size = preserve
    ? previous.slots.length
    : Math.min(ids.length, capacity);
  const rotate = ids.length > size;
  const selected = ids.indexOf(active);
  const visible = deckIndices(ids.length, selected, browsing, size);
  let desired = deckSlots(visible, selected, rotate).map((index) => ids[index]);
  /** @type {(string | null)[]} */
  let slots = desired;
  if (preserve) {
    // Passive membership updates cannot replace cards under a stationary
    // pointer. Rotation deliberately chooses a new window of neighbours.
    if (active === previous.active) {
      const survivors = /** @type {string[]} */ (
        previous.slots.filter((id) => id !== null && ids.includes(id))
      );
      desired = [...new Set([...survivors, ...desired])].slice(0, size);
    }
    slots = Array(size).fill(null);
    const anchor = previous.slots.indexOf(
      rotate || !ids.includes(previous.active) ? previous.active : active,
    );
    slots[anchor >= 0 ? anchor : size - 1] = active;
    previous.slots.forEach((id, slot) => {
      if (
        id !== null &&
        desired.includes(id) &&
        !slots.includes(id) &&
        slots[slot] === null
      )
        slots[slot] = id;
    });
    for (const id of desired) {
      if (slots.includes(id)) continue;
      const empty = slots.indexOf(null);
      if (empty < 0) break;
      slots[empty] = id;
    }
  }
  return { slots, active, hovered, capacity, width, headroom, rotate };
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
