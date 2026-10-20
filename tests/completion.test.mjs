import test from "node:test";
import assert from "node:assert/strict";
import { recordCompletion, activeCompletion } from "../shared/completion.mjs";

const done = (seq) => ({
  seq,
  type: "turn/end",
  data: { reason: { kind: "completed" } },
});
const state = (completions) => ({
  connection: "connected",
  selectedId: "front",
  sessions: [
    { sessionId: "front", title: "当前任务", running: true },
    { sessionId: "back", title: "后台任务", running: false },
  ],
  completions,
});

test("live completion reminders survive a new turn and expire without changing execution state", () => {
  const completions = recordCompletion([], "front", done(5), 1000);
  const live = state(completions);
  live.config = { expression: "proud" };
  assert.equal(activeCompletion(live, 1500).text, "当前任务 完成啦！");
  assert.equal(live.sessions[0].running, true);
  assert.equal(live.config.expression, "proud");
  assert.equal(activeCompletion(live, 6999).id, completions[0].id);
  assert.equal(activeCompletion(live, 7000), null);
});

test("duplicates do not restart reminders, and failure, cancel and unknown endings never celebrate", () => {
  const completions = recordCompletion([], "front", done(5), 1000);
  assert.equal(
    recordCompletion(completions, "front", done(5), 5000),
    completions,
  );
  for (const reason of [
    "error",
    "aborted",
    "interrupted",
    "max-tokens",
    "unknown",
    undefined,
  ])
    assert.equal(
      recordCompletion(
        completions,
        "front",
        { ...done(6), data: { reason } },
        5000,
      ),
      completions,
    );
  assert.equal(
    recordCompletion(
      completions,
      "front",
      { seq: 6, type: "tool/result" },
      5000,
    ),
    completions,
  );
  assert.equal(activeCompletion(state(completions), 7000), null);
});

test("background completions combine briefly and expire independently", () => {
  let completions = recordCompletion([], "front", done(5), 1000);
  completions = recordCompletion(completions, "back", done(5), 2000);
  assert.equal(
    activeCompletion(state(completions), 3000).text,
    "2 个任务完成啦！",
  );
  assert.equal(
    activeCompletion(state(completions), 7000).text,
    "后台任务 完成啦！",
  );
  completions = recordCompletion(completions, "back", done(8), 9000);
  assert.equal(
    completions.length,
    1,
    "expired records are pruned on the next completion",
  );
  assert.equal(activeCompletion(state(completions), 15000), null);
});

test("completion identities distinguish connections that reuse session IDs and sequences", () => {
  const first = recordCompletion([], "front", done(5), 1000, 1);
  const second = recordCompletion([], "front", done(5), 1000, 2);
  assert.notEqual(first[0].id, second[0].id);
  assert.equal(
    recordCompletion(second, "front", done(5), 2000, 2),
    second,
    "duplicates within one connection remain suppressed",
  );
});

test("only connected ordinary sessions show reminders, with no replay from list or history", () => {
  const live = state([]);
  assert.equal(activeCompletion(live, 2000), null);
  live.completions = recordCompletion([], "sub", done(5), 1000);
  live.sessions.push({ sessionId: "sub", origin: "subagent", title: "子任务" });
  assert.equal(activeCompletion(live, 2000), null);
  live.completions = recordCompletion([], "back", done(5), 1000);
  live.connection = "reconnecting";
  assert.equal(activeCompletion(live, 2000), null);
  live.connection = "connected";
  assert.equal(activeCompletion(live, 8000), null);
});
