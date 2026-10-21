import test from "node:test";
import assert from "node:assert/strict";
import {
  DECK_LIMIT,
  deckCapacity,
  deckIndices,
  deckLayout,
  deckSlots,
  deckTop,
  moveDeckPointer,
} from "../shared/progress-deck.mjs";
import { PET_CHARACTER } from "../shared/desktop-layout.mjs";

test("folding and browsing never expose more than five cards, including the selection", () => {
  // The deck is never mounted without sessions, but the helper stays total.
  assert.deepEqual(deckIndices(0, 0, false), []);
  assert.deepEqual(deckIndices(0, 0, true), []);
  assert.deepEqual(deckIndices(1, 0, false), [0]);
  assert.deepEqual(deckIndices(1, 0, true), [0]);
  assert.deepEqual(deckIndices(12, 11, false), [0, 1, 9, 10, 11]);
  assert.deepEqual(deckIndices(12, 5, true), [1, 2, 3, 4, 5]);
  assert.deepEqual(deckIndices(12, 11, true), [7, 8, 9, 10, 11]);
  assert.deepEqual(deckIndices(12, 0, true), [0, 1, 2, 3, 4]);
  for (let count = 1; count <= 30; count++)
    for (let selected = 0; selected < count; selected++)
      for (const browsing of [false, true]) {
        const indices = deckIndices(count, selected, browsing);
        assert.equal(indices.length, Math.min(count, DECK_LIMIT));
        assert.equal(new Set(indices).size, indices.length);
        assert.ok(indices.includes(selected));
        assert.ok(indices.every((index) => index >= 0 && index < count));
        if (!browsing)
          assert.ok(indices.includes(0) && indices.includes(count - 1));
        else
          // The browsing window ends on the selected card unless it would run
          // off an end of the list.
          assert.equal(
            indices.at(-1),
            Math.min(count - 1, Math.max(selected, DECK_LIMIT - 1)),
          );
      }
});

test("cards and caption stay above the character however high the pet is docked", () => {
  for (let headroom = 0; headroom <= 420; headroom++) {
    const capacity = deckCapacity(headroom);
    assert.ok(capacity >= 1 && capacity <= DECK_LIMIT);
    const layout = deckLayout(capacity, 300);
    const top = deckTop(headroom, layout.height);
    const front = layout.positions.at(-1);
    assert.ok(
      top + front.y + layout.cardHeight <= PET_CHARACTER.top,
      `headroom ${headroom}: cards stay above the character`,
    );
    if (capacity > 1)
      assert.ok(
        top + layout.height <= PET_CHARACTER.top,
        `headroom ${headroom}: the caption stays above the character`,
      );
  }
});

test("the visible set shrinks with the space above the pet but always keeps the selection", () => {
  for (let count = 1; count <= 12; count++)
    for (let selected = 0; selected < count; selected++)
      for (let limit = 1; limit <= DECK_LIMIT; limit++)
        for (const browsing of [false, true]) {
          const indices = deckIndices(count, selected, browsing, limit);
          assert.equal(indices.length, Math.min(count, limit));
          assert.equal(new Set(indices).size, indices.length);
          assert.ok(indices.includes(selected));
          assert.ok(indices.every((index) => index >= 0 && index < count));
        }
  // A tight budget keeps the selection and the newest session.
  assert.deepEqual(deckIndices(12, 5, false, 2), [5, 11]);
  assert.deepEqual(deckIndices(12, 5, false, 1), [5]);
});

test("the resting deck keeps the selected card in the front slot", () => {
  assert.deepEqual(deckSlots([0, 1, 5, 10, 11], 5, true), [0, 1, 10, 11, 5]);
  assert.deepEqual(deckSlots([0, 1, 9, 10, 11], 11, true), [0, 1, 9, 10, 11]);
  assert.deepEqual(deckSlots([0, 1, 5, 10, 11], 5, false), [0, 1, 5, 10, 11]);
  // A selected card that is not on screen leaves the order untouched.
  assert.deepEqual(deckSlots([0, 1, 9, 10, 11], 5, true), [0, 1, 9, 10, 11]);
  for (let count = 1; count <= 30; count++) {
    const indices = deckIndices(count, 0, false);
    for (const selected of indices) {
      const slots = deckSlots(indices, selected, true);
      assert.equal(slots.length, indices.length);
      assert.deepEqual(
        [...slots].sort((a, b) => a - b),
        indices,
      );
      assert.equal(slots.at(-1), selected);
    }
  }
});

test("horizontal cards stack toward the upper right and fit inside every supported pet width", () => {
  for (const width of [300, 366, 432])
    for (let count = 1; count <= DECK_LIMIT; count++) {
      const layout = deckLayout(count, width);
      assert.ok(layout.width <= width);
      for (let index = 1; index < count; index++) {
        const dx = layout.positions[index].x - layout.positions[index - 1].x;
        const dy = layout.positions[index].y - layout.positions[index - 1].y;
        assert.ok(dx < 0);
        assert.equal(dy, -dx);
      }
      for (const position of layout.positions)
        for (const [x, y] of [
          [0, 0],
          [layout.cardWidth, 0],
          [0, layout.cardHeight],
          [layout.cardWidth, layout.cardHeight],
        ]) {
          const px = position.x + x;
          const py = position.y + y;
          assert.ok(px >= 0 && px <= layout.width);
          assert.ok(py >= 0 && py <= layout.height);
        }
    }
});

test("upper-right motion browses backward and lower-left motion browses forward without stationary drift", () => {
  const cursor = { x: 100, y: 100, carry: 0 };
  // One card per card spacing: 24px along the diagonal is one card, 20px is not.
  assert.equal(moveDeckPointer(cursor, { x: 120, y: 80 }, 6, 12).selected, 6);
  assert.equal(moveDeckPointer(cursor, { x: 124, y: 76 }, 6, 12).selected, 5);
  assert.equal(moveDeckPointer(cursor, { x: 76, y: 124 }, 6, 12).selected, 7);
  // Perpendicular motion never browses.
  assert.equal(moveDeckPointer(cursor, { x: 135, y: 135 }, 6, 12).selected, 6);
  // A pointer that stops moving keeps the current card.
  const stepped = moveDeckPointer(cursor, { x: 130, y: 70 }, 6, 12);
  assert.equal(stepped.selected, 5);
  assert.equal(
    moveDeckPointer(stepped.pointer, { x: 130, y: 70 }, 5, 12).selected,
    5,
  );
  // Drift is measured from a fresh origin so the loop does not start on the
  // edge of the next step.
  let result = { pointer: cursor, selected: 5 };
  for (let i = 0; i < 30; i++) {
    result = moveDeckPointer(result.pointer, { x: 101, y: 99 }, 5, 12);
    result = moveDeckPointer(result.pointer, { x: 100, y: 100 }, 5, 12);
    assert.equal(result.selected, 5);
  }
  // The ends clamp the selection and clear the accumulated carry.
  result = moveDeckPointer(
    { x: 100, y: 100, carry: 0 },
    { x: 200, y: 0 },
    0,
    12,
  );
  assert.equal(result.selected, 0);
  assert.equal(result.pointer.carry, 0);
  assert.equal(
    moveDeckPointer(result.pointer, { x: 170, y: 30 }, 0, 12).selected,
    1,
  );
  assert.equal(moveDeckPointer(null, { x: 0, y: 0 }, 7, 12).selected, 7);
});
