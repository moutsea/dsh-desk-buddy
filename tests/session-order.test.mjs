import test from "node:test";
import assert from "node:assert/strict";
import {
  ProgressTracker,
  activeProgressItems,
  sessionCompletedAt,
} from "../shared/progress.mjs";
import { reconcileDeckOrder } from "../shared/progress-deck.mjs";

function setup() {
  const state = {
    connection: "connected",
    config: {},
    sessions: ["working", "dsh-done", "codex:done"].map((sessionId) => ({
      sessionId,
      provider: sessionId.startsWith("codex:") ? "codex" : "dsh",
      running: true,
      lastTurn: { key: "1", status: "thinking" },
    })),
    pending: [],
    activity: {},
    progressEntries: {},
  };
  const tracker = new ProgressTracker();
  const sync = (now) => (state.progressEntries = tracker.sync(state, now));
  const finish = (id, now) => {
    const row = state.sessions.find((item) => item.sessionId === id);
    row.running = false;
    row.lastTurn.status = "done";
    state.activity[id] = { status: "done" };
    sync(now);
  };
  const ordered = () =>
    [...state.sessions]
      .sort(
        (a, b) => sessionCompletedAt(state, b) - sessionCompletedAt(state, a),
      )
      .map((row) => row.sessionId);
  sync(100);
  return { state, tracker, sync, finish, ordered };
}

test("both platforms put completed sessions first, newest first, without changing source order", () => {
  const { state, finish, ordered } = setup();
  finish("codex:done", 200);
  finish("dsh-done", 300);
  const expected = ["dsh-done", "codex:done", "working"];
  assert.deepEqual(ordered(), expected);
  assert.deepEqual(
    activeProgressItems(state).map((item) => item.sessionId),
    expected,
  );
  assert.deepEqual(
    state.sessions.map((row) => row.sessionId),
    ["working", "dsh-done", "codex:done"],
  );
  state.activity.working = { status: "replying", at: 9999 };
  assert.deepEqual(
    ordered(),
    expected,
    "streaming cannot outrank completed work",
  );
});

test("completion priority survives refresh, reconnect and dismissal, and resets for a new turn", () => {
  const { state, tracker, sync, finish, ordered } = setup();
  finish("dsh-done", 200);
  finish("codex:done", 300);
  state.activity = {};
  state.connection = "reconnecting";
  sync(400);
  state.connection = "connected";
  state.sessions[1].updatedAt = 9999;
  sync(500);
  assert.equal(state.progressEntries["dsh-done"].completedAt, 200);
  assert.equal(state.progressEntries["codex:done"].completedAt, 300);
  tracker.dismiss("codex:done");
  sync(600);
  assert.equal(ordered()[0], "codex:done");
  assert.ok(
    !activeProgressItems(state).some((item) => item.sessionId === "codex:done"),
  );
  const row = state.sessions[2];
  row.running = true;
  row.lastTurn = { key: "2", status: "thinking" };
  tracker.start(row.sessionId, "2");
  sync(700);
  assert.equal(state.progressEntries[row.sessionId].completedAt, undefined);
  assert.equal(ordered()[0], "dsh-done");
  assert.equal(activeProgressItems(state)[0].sessionId, "dsh-done");
});

test("fast completion retains its original time while waiting for metadata", () => {
  const { state, tracker, sync } = setup();
  tracker.start("fast", "1", false);
  tracker.end("fast", "done", 150);
  state.sessions.push({ sessionId: "fast", running: false, readOnly: true });
  sync(500);
  assert.equal(state.progressEntries.fast.completedAt, 150);
  state.pending.push({ sessionId: "fast" });
  assert.equal(sessionCompletedAt(state, state.sessions.at(-1)), 0);
});

const item = (sessionId, completedAt = 0) => ({ sessionId, completedAt });
const initialDeck = () => ({ order: ["a", "b", "c"], completed: {} });

test("deck promotes completion but keeps streaming and repeated snapshots stable", () => {
  const items = [item("a", 200), item("b"), item("c")];
  const first = reconcileDeckOrder(initialDeck(), items, false);
  assert.deepEqual(first.order, ["b", "c", "a"]);
  assert.equal(first.promoted, "a");
  const repeat = reconcileDeckOrder(first, [...items].reverse(), false);
  assert.deepEqual(repeat.order, first.order);
  assert.equal(repeat.promoted, undefined);
  const second = reconcileDeckOrder(
    repeat,
    [item("a", 200), item("b", 300), item("c")],
    false,
  );
  assert.deepEqual(second.order, ["c", "a", "b"]);
  assert.equal(second.promoted, "b");
});

test("deck defers completion reordering during browsing, including membership changes", () => {
  const items = [item("a", 200), item("b"), item("c")];
  const hovered = reconcileDeckOrder(initialDeck(), items, true);
  assert.deepEqual(hovered.order, ["a", "b", "c"]);
  assert.equal(hovered.promoted, undefined);
  const changed = reconcileDeckOrder(hovered, [...items, item("d", 300)], true);
  assert.deepEqual(changed.order, ["a", "b", "c", "d"]);
  const idle = reconcileDeckOrder(changed, [...items, item("d", 300)], false);
  assert.deepEqual(idle.order, ["b", "c", "a", "d"]);
  assert.equal(idle.promoted, "d");
  assert.equal(
    reconcileDeckOrder(idle, [...items, item("d", 300)], false).promoted,
    undefined,
  );
});

test("restarted and removed cards lose completion priority without reviving dismissed cards", () => {
  const old = { order: ["c", "a", "b"], completed: { a: 200, b: 300 } };
  const restarted = reconcileDeckOrder(
    old,
    [item("a", 200), item("b"), item("c")],
    false,
  );
  assert.deepEqual(restarted.order, ["c", "b", "a"]);
  assert.equal(restarted.completed.b, undefined);
  const removed = reconcileDeckOrder(restarted, [item("b"), item("c")], false);
  assert.deepEqual(removed.order, ["c", "b"]);
  assert.deepEqual(removed.completed, {});
});

test("automatically selected work yields to the latest remaining completion on restart", () => {
  const previous = {
    order: ["c", "a", "b"],
    completed: { a: 200, b: 300 },
    automatic: "b",
  };
  const items = [item("a", 200), item("b"), item("c")];
  const next = reconcileDeckOrder(previous, items, false);
  assert.equal(next.promoted, "a");
  assert.equal(next.automatic, "a");
  assert.equal(reconcileDeckOrder(next, items, false).promoted, undefined);
  const empty = reconcileDeckOrder(
    next,
    items.map((row) => item(row.sessionId)),
    false,
  );
  assert.equal(empty.promoted, undefined);
  assert.equal(empty.automatic, undefined);
});

test("automatic selection fallback waits for browsing to end", () => {
  const previous = {
    order: ["a", "b"],
    completed: { a: 200, b: 300 },
    automatic: "b",
  };
  const items = [item("a", 200), item("b")];
  const browsing = reconcileDeckOrder(previous, items, true);
  assert.equal(browsing.promoted, undefined);
  assert.equal(browsing.automatic, "b");
  assert.equal(reconcileDeckOrder(browsing, items, false).promoted, "a");
});

test("manual selection is preserved when another session loses completion priority", () => {
  const previous = { order: ["c", "a", "b"], completed: { a: 200, b: 300 } };
  const next = reconcileDeckOrder(
    previous,
    [item("a", 200), item("b"), item("c")],
    false,
  );
  assert.equal(next.promoted, undefined);
  assert.equal(next.automatic, undefined);
});

test("late metadata for older completed work cannot displace the newest completion", () => {
  const previous = { order: ["a", "b"], completed: { b: 300 }, automatic: "b" };
  const next = reconcileDeckOrder(
    previous,
    [item("a", 200), item("b", 300)],
    false,
  );
  assert.equal(next.promoted, "b");
  assert.equal(next.automatic, "b");
});
