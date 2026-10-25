import test from "node:test";
import assert from "node:assert/strict";
import {
  DECK_LIMIT,
  deckCapacity,
  deckIndices,
  deckLayout,
  deckSlots,
  deckTop,
  reconcileDeckView,
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

const viewOf = (ids, active, previous, options = {}) =>
  reconcileDeckView(previous, {
    ids,
    active,
    hovered: true,
    browsing: true,
    capacity: 5,
    width: 300,
    headroom: 250,
    ...options,
  });

test("new sessions cannot displace hovered cards when the deck starts rotating", () => {
  for (const capacity of [1, 2, 5]) {
    const ids = ["a", "b", "c", "d", "e"].slice(0, capacity);
    for (const active of ids) {
      const before = viewOf(ids, active, undefined, { capacity });
      const after = viewOf([...ids, "new"], active, before, { capacity });
      assert.deepEqual(after.slots, before.slots);
      assert.equal(after.rotate, true);
      // Later streaming updates must not unfreeze the frame.
      assert.deepEqual(
        viewOf([...ids, "new", "another"], active, after, { capacity }).slots,
        before.slots,
      );
    }
  }
});

test("added sessions stay reachable by rotation without moving the active slot", () => {
  const ids = ["a", "b", "c", "d", "e"];
  let view = viewOf(ids, "b");
  const anchor = view.slots.indexOf("b");
  ids.push("new", "another");
  view = viewOf(ids, "b", view);
  for (const active of [...ids, ...ids.toReversed()]) {
    view = viewOf(ids, active, view);
    assert.equal(view.slots[anchor], active);
    assert.equal(view.slots.length, 5);
    assert.equal(new Set(view.slots).size, 5);
    assert.ok(view.slots.every((id) => ids.includes(id)));
  }
});

test("growth below capacity preserves the hovered frame and expands on exit", () => {
  for (const count of [1, 3]) {
    const ids = ["a", "b", "c"].slice(0, count);
    const before = viewOf(ids, "a");
    ids.push("new");
    const after = viewOf(ids, "a", before);
    assert.deepEqual(after.slots, before.slots);
    assert.equal(after.rotate, true);
    const rotated = viewOf(ids, "new", after);
    assert.equal(rotated.slots[0], "new");
    assert.equal(rotated.slots.length, count);
    const resting = viewOf(ids, "new", rotated, {
      hovered: false,
      browsing: false,
    });
    assert.deepEqual(resting.slots, ids);
    assert.equal(resting.rotate, false);
  }
});

test("removals keep surviving targets in place and refill only empty slots", () => {
  const before = viewOf(["a", "b", "c", "d", "e"], "c");
  const removed = viewOf(["a", "c", "e"], "c", before);
  assert.deepEqual(removed.slots, ["a", null, "c", null, "e"]);
  const added = viewOf(["a", "c", "e", "new"], "c", removed);
  assert.deepEqual(added.slots, ["a", "new", "c", null, "e"]);
  const replaced = viewOf(["a", "e", "new"], "e", added);
  assert.equal(
    replaced.slots[2],
    "e",
    "replacement occupies the removed active slot",
  );
  assert.deepEqual(replaced.slots.filter(Boolean).sort(), ["a", "e", "new"]);
  assert.deepEqual(viewOf([], undefined, replaced).slots, []);
});

test("a pointer hover keeps every card in its existing physical slot", () => {
  const ids = ["a", "b", "c", "d", "e"];
  let view = viewOf(ids, "e", undefined, { hovered: false, browsing: false });
  for (const active of ids) {
    view = viewOf(ids, active, view);
    assert.equal(view.rotate, false);
    assert.deepEqual(view.slots, ids);
  }
});

test("viewport changes release the hover frame to respect the available space", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const before = viewOf(ids.slice(0, 5), "b");
  const held = viewOf(ids, "b", before);
  for (const options of [
    { capacity: 2, headroom: 60 },
    { capacity: 1, headroom: 0 },
    { width: 366 },
    { headroom: 200 },
  ]) {
    const view = viewOf(ids, "b", held, options);
    assert.equal(view.slots.at(-1), "b");
    assert.equal(view.slots.length, options.capacity || 5);
  }
});

test("keyboard-only browsing does not freeze the frame when sessions are added", () => {
  const before = viewOf(["a"], "a", undefined, { hovered: false });
  const after = viewOf(["a", "new"], "a", before, { hovered: false });
  assert.deepEqual(after.slots, ["a", "new"]);
  assert.equal(after.rotate, false);
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

test("entering a folded deck keeps the resting window, so cards keep their slots", () => {
  // Hovering reports `hovered` but not `browsing`: browsing is what re-windows a
  // folded deck around the selection. Re-windowing on hover swapped the rear
  // cards (and their close buttons) out from under a pointer travelling to one.
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
  for (let selected = 0; selected < ids.length; selected++) {
    const resting = viewOf(ids, ids[selected], undefined, { hovered: false });
    const hovering = viewOf(ids, ids[selected], resting, { hovered: true });
    assert.deepEqual(hovering.slots, resting.slots);
    assert.equal(hovering.rotate, true);
    // Keyboard browsing still walks the deck around the selection.
    const walking = viewOf(ids, ids[selected], resting, { browsing: true });
    assert.deepEqual(
      walking.slots,
      deckSlots(deckIndices(12, selected, true), selected, true).map(
        (index) => ids[index],
      ),
    );
  }
});

test("pointer travel never restacks the deck, so close buttons stay put", () => {
  // Hovering used to select a card, which re-slotted large decks and slid the
  // close button away from a pointer on its way there. Selection now only
  // changes from the keyboard or a click, and rotating decks always keep the
  // selected card in the front slot regardless of pointer travel.
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
  for (let selected = 0; selected < ids.length; selected++) {
    const view = viewOf(ids, ids[selected], undefined, {
      hovered: true,
      browsing: true,
    });
    assert.equal(view.rotate, true);
    assert.equal(view.slots.length, DECK_LIMIT);
    assert.equal(view.slots.at(-1), ids[selected]);
    assert.equal(new Set(view.slots).size, DECK_LIMIT);
  }
});
