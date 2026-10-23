import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceActivity,
  reconcileActivity,
  reconcileSessionActivity,
  sessionMood,
  overallMood,
  toolActivity,
  endStatus,
} from "../shared/activity.mjs";

const event = (seq, type, data = {}) => ({ seq, type, data });
const result = (toolCallId, isError = false) => ({
  message: {
    role: "user",
    content: [
      {
        type: "tool-result",
        toolCallId,
        isError,
        content: [{ type: "text", text: isError ? "failed" : "ok" }],
      },
    ],
  },
});

test("new snapshot turns clear old activity while preserving event ordering and current live phases", () => {
  const old = {
    turn: "old",
    seq: 20,
    status: "error",
    message: "old failure",
    at: 1000,
    reaction: { mood: "shocked", until: 5000 },
    preview: "old reply",
  };
  const session = { running: false, lastTurn: { key: "new", status: "done" } };
  const fresh = reconcileSessionActivity(old, session, 2000);
  assert.deepEqual(fresh, { turn: "new", seq: 20 });
  assert.equal(
    sessionMood(fresh, false, 2000),
    "idle",
    "history must not replay a reaction",
  );
  assert.equal(
    reduceActivity(fresh, event(20, "turn/end", { reason: "error" })),
    fresh,
  );
  assert.equal(reconcileSessionActivity(fresh, session, 2100), fresh);
  const running = reconcileSessionActivity(
    old,
    { ...session, running: true },
    2200,
  );
  assert.deepEqual(running, {
    turn: "new",
    seq: 20,
    status: "thinking",
    at: 2200,
  });
  const stopped = reconcileSessionActivity(running, session, 2300);
  assert.deepEqual(stopped, { turn: "new", seq: 20, status: "idle" });
  const live = {
    turn: "new",
    seq: 21,
    status: "working",
    tools: { shell: "bash" },
  };
  assert.equal(
    reconcileSessionActivity(live, { ...session, running: true }),
    live,
  );
  assert.equal(
    reconcileSessionActivity(old, { running: false }),
    old,
    "unknown identity must not erase live activity",
  );
});

test("cached metadata cannot erase newer live work or its terminal state", () => {
  const live = {
    turn: "new",
    seq: 7,
    metadataRevision: 4,
    status: "working",
    tools: { shell: "bash" },
    toolSummary: "bash · npm test",
  };
  for (const activity of [
    live,
    { ...live, status: "error", message: "current error", tools: {} },
  ]) {
    for (const metadataRevision of [3, 4]) {
      for (const running of [false, true]) {
        const cached = {
          readOnly: true,
          running,
          metadataRevision,
          lastTurn: { key: "old", status: "done" },
        };
        assert.equal(reconcileSessionActivity(activity, cached), activity);
      }
    }
    assert.equal(
      reconcileSessionActivity(activity, {
        running: false,
        runningKnown: false,
        metadataRevision: 5,
      }),
      activity,
      "reconnect placeholders cannot end live work",
    );
  }
  const fresh = {
    running: true,
    readOnly: false,
    metadataRevision: 5,
    lastTurn: { key: "new", status: "thinking" },
  };
  assert.equal(reconcileSessionActivity(live, fresh), live);
  const ended = reconcileSessionActivity(live, { ...fresh, running: false });
  assert.equal(
    ended.status,
    "idle",
    "a genuinely newer idle snapshot still ends work",
  );
  assert.equal(
    ended.metadataRevision,
    4,
    "host reconciliation preserves the live version floor",
  );
  const next = reconcileSessionActivity(ended, {
    ...fresh,
    running: false,
    metadataRevision: 6,
    lastTurn: { key: "next", status: "done" },
  });
  assert.deepEqual(next, { turn: "next", seq: 7 });
});

test("real tool names classify studying and parallel tools keep the remaining phase", () => {
  for (const name of [
    "read",
    "read_image",
    "fs.read",
    "web_search",
    "web_fetch",
    "mcp.search",
  ])
    assert.equal(toolActivity(name), "learning");
  for (const name of ["write", "apply_patch", "bash", "custom_tool"])
    assert.equal(toolActivity(name), "working");
  let state = reduceActivity(null, event(0, "turn/start"), 1000);
  state = reduceActivity(
    state,
    event(1, "tool/call", { callId: "r", name: "read" }),
    1100,
  );
  assert.equal(sessionMood(state, true, 1100), "learning");
  state = reduceActivity(
    state,
    event(2, "tool/call", { callId: "w", name: "bash" }),
    1200,
  );
  state = reduceActivity(state, event(3, "tool/result", result("r")), 1250);
  assert.equal(sessionMood(state, true, 1300), "working");
  assert.deepEqual(state.tools, { w: "bash" });
  state = reduceActivity(state, event(4, "tool/result", result("w")), 1400);
  assert.equal(
    sessionMood(state, true, 1500),
    "working",
    "short tools remain visible",
  );
  assert.equal(sessionMood(state, true, 2700), "thinking");
  state = reduceActivity(
    state,
    event(5, "assistant/chunk", {
      chunk: { type: "text-delta", text: "hello" },
    }),
    2800,
  );
  assert.equal(sessionMood(state, true, 2800), "replying");
});

test("structured tool failure shocks briefly while retrying, then a successful turn celebrates and settles", () => {
  let state = reduceActivity(
    null,
    event(0, "tool/call", { callId: "r", name: "read" }),
    1000,
  );
  state = reduceActivity(
    state,
    event(1, "tool/result", result("r", true)),
    1100,
  );
  state = reduceActivity(
    state,
    event(2, "tool/call", { callId: "retry", name: "bash" }),
    1200,
  );
  assert.equal(sessionMood(state, true, 2000), "shocked");
  assert.equal(
    state.status,
    "working",
    "reaction does not falsify execution state",
  );
  assert.equal(sessionMood(state, true, 5100), "working");
  state = reduceActivity(
    state,
    event(3, "turn/end", { reason: { kind: "completed" } }),
    6000,
  );
  assert.equal(sessionMood(state, false, 6000), "celebrating");
  assert.equal(sessionMood(state, false, 12000), "done");
  assert.equal(sessionMood(state, false, 18000), "idle");
});

test("failed turns shock then become concerned; cancel, blocked, max-tokens and unknown never celebrate", () => {
  const failed = reduceActivity(
    null,
    event(0, "turn/end", {
      reason: { kind: "error", error: { message: "offline" } },
    }),
    1000,
  );
  assert.equal(sessionMood(failed, false, 1000), "error");
  assert.equal(sessionMood(failed, false, 5000), "concerned");
  assert.equal(sessionMood(failed, false, 21000), "idle");
  for (const kind of [
    "aborted",
    "interrupted",
    "blocked",
    "max-tokens",
    "extension-ended",
    undefined,
  ]) {
    assert.notEqual(endStatus({ kind }), "done");
    const state = reduceActivity(
      failed,
      event(1, "turn/end", { reason: { kind } }),
      22000,
    );
    assert.notEqual(sessionMood(state, false, 22000), "celebrating");
  }
});

test("duplicate/out-of-order frames do not restart reactions and a new turn clears old emotion", () => {
  const start = reduceActivity(null, event(10, "turn/start"), 1000);
  const done = reduceActivity(
    start,
    event(11, "turn/end", { reason: "completed" }),
    2000,
  );
  assert.equal(
    reduceActivity(done, event(11, "turn/end", { reason: "completed" }), 50000),
    done,
  );
  assert.equal(
    reduceActivity(done, event(9, "tool/call", { name: "read" }), 50000),
    done,
  );
  const newTurn = reduceActivity(done, event(12, "turn/start"), 50000);
  assert.equal(sessionMood(newTurn, true, 50000), "thinking");
  const work = reduceActivity(
    newTurn,
    event(13, "tool/call", { name: "read" }),
    51000,
  );
  assert.equal(
    reconcileActivity(work, true, 52000),
    work,
    "host polling preserves studying",
  );
  assert.equal(
    reconcileActivity(done, false, 52000),
    done,
    "host false does not reset completion timer",
  );
  assert.equal(sessionMood(reconcileActivity(work, false), false), "idle");
});

test("global companion sees background completion/errors, prioritizes waiting and returns to ongoing work", () => {
  const state = {
    connection: "connected",
    pending: [],
    selectedId: "front",
    sessions: [
      { sessionId: "front", running: true },
      { sessionId: "back", running: false },
    ],
    activity: {
      front: { status: "working", at: 1000 },
      back: { status: "done", at: 2000 },
    },
  };
  assert.equal(overallMood(state, 2500), "celebrating");
  assert.equal(overallMood(state, 8000), "working");
  state.activity.back = { status: "error", at: 9000 };
  assert.equal(overallMood(state, 9000), "error");
  assert.equal(
    overallMood(state, 13000),
    "working",
    "old failure does not mask active work",
  );
  state.pending.push({ sessionId: "back" });
  assert.equal(overallMood(state, 9500), "waiting");
  state.connection = "reconnecting";
  assert.equal(overallMood(state, 9500), "offline");
});
