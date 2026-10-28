import test from "node:test";
import assert from "node:assert/strict";
import {
  activeProgress,
  activeProgressItems,
  ProgressTracker,
} from "../shared/progress.mjs";
import {
  reduceActivity,
  reconcileSessionActivity,
} from "../shared/activity.mjs";
import { projectSession } from "../shared/projection.mjs";
import { toolPresentation } from "../shared/tool-presentation.mjs";

const event = (seq, type, data = {}) => ({ seq, type, data });
const stateFor = () => ({
  connection: "connected",
  config: {},
  sessions: [
    { sessionId: "front", title: "当前任务", running: false },
    { sessionId: "back", title: "后台任务", running: true },
  ],
  selectedId: "front",
  pending: [],
  activity: {},
  liveAssistant: {},
});

test("tool calls retain actual commands and readable arguments in chat", () => {
  const command = "git status --short\nnpm test";
  for (const args of [{ command }, JSON.stringify({ command })]) {
    const call = event(1, "tool/call", { name: "bash", arguments: args });
    const message = projectSession([call], true).messages[0];
    assert.equal(message.name, "bash");
    assert.equal(message.detail, command);
    assert.deepEqual(JSON.parse(message.arguments), { command });
  }
  assert.equal(
    toolPresentation({ arguments: "raw command" }).detail,
    "raw command",
  );
  assert.equal(
    toolPresentation({ arguments: '{"cmd":["git","status"]}' }).detail,
    "git status",
  );
  assert.equal(
    toolPresentation({ arguments: { file_path: "src/main.tsx" } }).detail,
    "src/main.tsx",
  );
  assert.equal(toolPresentation({ arguments: "{invalid" }).detail, "{invalid");
  assert.equal(toolPresentation().arguments, "");
});

test("progress follows public text and parallel tool arguments, clearing old steps and turns", () => {
  let activity = reduceActivity(null, event(0, "turn/start"), 1000);
  activity = reduceActivity(
    activity,
    event(1, "assistant/chunk", {
      chunk: { type: "text-delta", text: "先检查项目" },
    }),
    1100,
  );
  assert.equal(activity.preview, "先检查项目");
  activity = reduceActivity(
    activity,
    event(2, "tool/call", {
      name: "bash",
      callId: "shell",
      arguments: '{"command":"npm test"}',
    }),
    1200,
  );
  activity = reduceActivity(
    activity,
    event(3, "tool/call", {
      name: "read",
      callId: "read",
      arguments: { path: "README.md" },
    }),
    1300,
  );
  assert.match(activity.toolSummary, /README.md/);
  activity = reduceActivity(
    activity,
    event(4, "tool/result", {
      message: { content: [{ type: "tool-result", toolCallId: "read" }] },
    }),
    1400,
  );
  assert.equal(activity.toolSummary, "bash · npm test");
  assert.equal(activity.preview, "");
  activity = reduceActivity(
    activity,
    event(5, "tool/result", {
      message: { content: [{ type: "tool-result", toolCallId: "shell" }] },
    }),
    1500,
  );
  assert.equal(activity.toolSummary, undefined);
  assert.deepEqual(activity.toolDetails, {});
  const chunk = event(6, "assistant/chunk", {
    chunk: { type: "text-delta", text: "检查完成" },
  });
  activity = reduceActivity(activity, chunk, 1600);
  assert.equal(reduceActivity(activity, chunk, 1700), activity);
  assert.equal(activity.preview, "检查完成");
  activity = reduceActivity(activity, event(7, "step/start"), 1800);
  assert.equal(activity.preview, "");
  activity = reduceActivity(
    activity,
    event(8, "assistant/chunk", {
      chunk: { type: "reasoning-delta", text: "private reasoning" },
    }),
    1900,
  );
  assert.equal(activity.preview, "");
  activity = reduceActivity(activity, event(9, "turn/start"), 2000);
  assert.equal(activity.toolSummary, undefined);
  assert.equal(activity.preview, undefined);
});

test("bubble prioritizes pending actions, then selected running work, then background work", () => {
  const state = stateFor();
  assert.equal(activeProgress(state).sessionId, "back");
  assert.equal(activeProgress(state).text, "正在思考");
  state.sessions[0].running = true;
  state.activity.back = {
    status: "working",
    toolSummary: "bash · npm test",
    at: 3000,
  };
  assert.equal(activeProgress(state).sessionId, "front");
  state.selectedId = "missing";
  assert.equal(activeProgress(state).text, "bash · npm test");
  state.pending = [
    { sessionId: "front", questions: [{ question: "继续吗？" }] },
  ];
  assert.equal(activeProgress(state).sessionId, "front");
  assert.equal(activeProgress(state).text, "继续吗？");
  assert.equal(activeProgress(state).status, "waiting");
});

test("host errors replace stale tool previews with the actual failure", () => {
  const state = stateFor();
  state.activity.back = {
    status: "error",
    toolSummary: "bash · npm test",
    message: "连接已中断",
  };
  assert.equal(activeProgress(state).label, "执行出错");
  assert.equal(activeProgress(state).text, "连接已中断");
  state.activity.back.message = "";
  assert.equal(activeProgress(state).text, "执行出错");
});

test("stream preview shows latest public output and obeys off, disconnect and terminal state", () => {
  const state = stateFor();
  state.activity.back = { status: "replying", preview: "已提交的过程说明" };
  assert.equal(activeProgress(state).text, "已提交的过程说明");
  state.liveAssistant.back = { text: "实时进展" };
  assert.equal(activeProgress(state).text, "实时进展");
  state.liveAssistant.back.text = "前".repeat(200) + "最新进展";
  assert.ok(activeProgress(state).text.endsWith("最新进展"));
  state.config.progressBubbles = false;
  assert.equal(activeProgress(state), null);
  state.config.progressBubbles = true;
  state.connection = "reconnecting";
  assert.equal(activeProgress(state), null);
  state.connection = "connected";
  state.sessions[1].running = false;
  assert.equal(activeProgress(state), null);
  state.sessions[1].running = true;
  state.sessions[1].origin = "subagent";
  assert.equal(activeProgress(state), null);
  state.pending = [{ sessionId: "deleted", reason: "stale" }];
  assert.equal(activeProgress(state), null);
});

test("parallel bubbles include each running or pending session exactly once and drop finished work", () => {
  const state = stateFor();
  state.sessions.push(
    { sessionId: "waiting", title: "待回应", running: false },
    { sessionId: "child", origin: "subagent", running: true },
  );
  state.sessions[0].running = true;
  state.pending = [
    { sessionId: "waiting", reason: "允许继续吗？" },
    { sessionId: "waiting", reason: "另一个请求" },
    { sessionId: "front", reason: "请确认" },
    { sessionId: "child", reason: "子代理" },
    { sessionId: "deleted", reason: "已删除" },
  ];
  state.activity.back = { status: "working", toolSummary: "bash · npm test" };
  const items = activeProgressItems(state);
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["front", "waiting", "back"],
  );
  assert.deepEqual(
    items.map((item) => item.text),
    ["请确认", "允许继续吗？", "bash · npm test"],
  );
  assert.equal(items[1].status, "waiting");
  state.sessions[1].running = false;
  assert.deepEqual(
    activeProgressItems(state).map((item) => item.sessionId),
    ["front", "waiting"],
  );
  state.connection = "reconnecting";
  assert.deepEqual(activeProgressItems(state), []);
  state.connection = "connected";
  state.config.progressBubbles = false;
  assert.deepEqual(activeProgressItems(state), []);
});

test("observed DSH and Codex bubbles retain terminal states without surfacing old history", () => {
  for (const provider of ["dsh", "codex"]) {
    for (const [status, label] of [
      ["done", "已完成"],
      ["cancelled", "已停止"],
      ["error", "执行出错"],
      ["blocked", "已暂停"],
      ["idle", "本轮已结束"],
    ]) {
      const tracker = new ProgressTracker(),
        state = stateFor();
      state.sessions[1].provider = provider;
      state.sessions.push({
        sessionId: "history",
        readOnly: true,
        running: false,
      });
      state.activity.history = { status: "done" };
      state.progressEntries = tracker.sync(state);
      state.sessions[1].running = false;
      state.activity.back = { status };
      state.progressEntries = tracker.sync(state);
      assert.deepEqual(
        activeProgressItems(state).map((row) => row.sessionId),
        ["back"],
      );
      assert.equal(activeProgress(state).label, label);
      state.activity = {}; // A reconnect may replace transient activity.
      state.progressEntries = tracker.sync(state);
      assert.equal(activeProgress(state).label, label);
    }
  }
});

test("closing hides only that bubble through activity, completion, settings and reconnect until new work", () => {
  const tracker = new ProgressTracker(),
    state = stateFor();
  tracker.start("back", "turn-1");
  state.progressEntries = tracker.sync(state);
  tracker.dismiss("back");
  state.progressEntries = tracker.sync(state);
  assert.equal(state.sessions[1].running, true);
  assert.equal(activeProgress(state), null);
  tracker.start("back", "turn-1"); // duplicate start cannot reopen it
  state.pending = [{ sessionId: "back", reason: "批准吗？" }];
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
  state.config.progressBubbles = false;
  state.connection = "reconnecting";
  state.sessions[1].running = false;
  state.progressEntries = tracker.sync(state);
  state.connection = "connected";
  state.sessions[1].running = true;
  state.config.progressBubbles = true;
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
  state.sessions[1].running = false;
  state.pending = [];
  state.activity.back = { status: "done" };
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
  tracker.start("back", "turn-2");
  state.sessions[1].running = true;
  state.activity.back = { status: "thinking" };
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state).label, "正在思考");
  tracker.dismiss("back");
  tracker.start("back", "turn-3"); // queued turns may have no idle snapshot
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state).sessionId, "back");
});

test("retained bubbles are removed with their session and source IDs stay independent", () => {
  const tracker = new ProgressTracker(),
    state = stateFor();
  state.sessions.push({
    sessionId: "codex:back",
    provider: "codex",
    running: true,
  });
  state.progressEntries = tracker.sync(state);
  tracker.dismiss("back");
  state.progressEntries = tracker.sync(state);
  assert.deepEqual(
    activeProgressItems(state).map((row) => row.sessionId),
    ["codex:back"],
  );
  state.sessions = state.sessions.filter(
    (row) => row.sessionId !== "codex:back",
  );
  tracker.prune(state.sessions);
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
  assert.equal(state.progressEntries["codex:back"], undefined);
});

test("each provider hides disconnected or unverified bubbles without losing retention or dismissal", () => {
  for (const provider of ["dsh", "codex"]) {
    for (const finished of [false, true]) {
      for (const hidden of [false, true]) {
        const tracker = new ProgressTracker(),
          state = stateFor();
        const other = provider === "dsh" ? "codex" : "dsh";
        const row = state.sessions[1];
        row.provider = provider;
        row.lastTurn = { key: "first", status: "thinking" };
        state.sessions[0].provider = other;
        state.sessions[0].running = true;
        state.connections = {
          dsh: { status: "connected" },
          codex: { status: "connected" },
        };
        tracker.sync(state);
        if (finished) {
          row.running = false;
          row.lastTurn.status = "done";
          tracker.sync(state);
        }
        if (hidden) tracker.dismiss("back");
        state.connections[provider].status = "reconnecting";
        row.runningKnown = true;
        state.progressEntries = tracker.sync(state);
        assert.deepEqual(
          activeProgressItems(state).map((item) => item.sessionId),
          ["front"],
          "even cached known state must be hidden when its platform is offline",
        );
        for (const connection of ["reconnecting", "offline", "connected"]) {
          state.connections[provider].status = connection;
          row.running = false;
          row.runningKnown = false;
          state.progressEntries = tracker.sync(state);
          assert.deepEqual(
            activeProgressItems(state).map((item) => item.sessionId),
            ["front"],
          );
          assert.equal(state.progressEntries.back.active, !finished);
          assert.equal(state.progressEntries.back.hidden, hidden);
        }
        row.runningKnown = true;
        row.running = !finished;
        state.progressEntries = tracker.sync(state);
        assert.equal(
          activeProgressItems(state).some((item) => item.sessionId === "back"),
          !hidden,
        );
        tracker.dismiss("back");
        row.lastTurn = { key: "second", status: "thinking" };
        row.running = true;
        state.progressEntries = tracker.sync(state);
        assert.equal(
          activeProgressItems(state).find((item) => item.sessionId === "back")
            .label,
          "正在思考",
        );
      }
    }
  }
});

test("reconnect waits for a fresh runtime snapshot before detecting another task", () => {
  for (const provider of ["dsh", "codex"]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.provider = provider;
    state.connections = { [provider]: { status: "connected" } };
    state.progressEntries = tracker.sync(state);
    tracker.dismiss("back");
    state.connections[provider].status = "reconnecting";
    row.running = false;
    row.runningKnown = false;
    tracker.sync(state);
    // Ready precedes session.list. Unrelated broadcasts (and failed refreshes)
    // can repeat this stale false while the original task is still running.
    state.connections[provider].status = "connected";
    for (let i = 0; i < 3; i++) {
      state.progressEntries = tracker.sync(state);
      assert.equal(state.progressEntries.back.active, true);
      assert.equal(state.progressEntries.back.hidden, true);
    }
    row.running = true;
    row.runningKnown = true;
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null, "the same task stays hidden");
    // A genuine idle snapshot followed by running is still a new task, even
    // when the provider doesn't send a turn/start event.
    row.running = false;
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.back.active, false);
    assert.equal(activeProgress(state), null);
    row.running = true;
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state).sessionId, "back");
  }
});

test("reconnect turn identity keeps the same task hidden and reopens a new active or completed task", () => {
  for (const provider of ["dsh", "codex"]) {
    for (const running of [true, false]) {
      const tracker = new ProgressTracker(),
        state = stateFor(),
        row = state.sessions[1];
      row.provider = provider;
      row.lastTurn = { key: "first", status: "thinking" };
      state.progressEntries = tracker.sync(state);
      tracker.dismiss("back");
      row.running = false;
      row.runningKnown = false;
      delete row.lastTurn;
      tracker.sync(state);
      row.running = true;
      row.runningKnown = true;
      state.progressEntries = tracker.sync(state);
      assert.equal(
        activeProgress(state),
        null,
        "unknown history must not undo dismissal",
      );
      row.lastTurn = { key: "first", status: "thinking" };
      state.progressEntries = tracker.sync(state);
      assert.equal(activeProgress(state), null, "same turn remains hidden");
      row.running = running;
      row.lastTurn = { key: "second", status: running ? "thinking" : "done" };
      state.progressEntries = tracker.sync(state);
      assert.equal(
        activeProgress(state).label,
        running ? "正在思考" : "已完成",
      );
      assert.equal(state.progressEntries.back.turn, "second");
      tracker.dismiss("back");
      row.running = false;
      row.lastTurn = { key: "second", status: "done" };
      state.progressEntries = tracker.sync(state);
      assert.equal(
        activeProgress(state),
        null,
        "completion cannot undo the new dismissal",
      );
    }
  }
});

test("history identity cannot create bubbles for idle history or reopen a retained unloaded turn", () => {
  const tracker = new ProgressTracker(),
    state = stateFor();
  const idle = state.sessions[0],
    active = state.sessions[1];
  idle.lastTurn = { key: "old", status: "done" };
  active.lastTurn = { key: "current", status: "thinking" };
  state.progressEntries = tracker.sync(state);
  assert.equal(state.progressEntries.front, undefined);
  active.running = false;
  active.lastTurn.status = "done";
  state.progressEntries = tracker.sync(state);
  active.readOnly = true;
  delete active.lastTurn;
  tracker.prune(state.sessions);
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state).label, "已完成");
  tracker.dismiss("back");
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
});

test("a reverted history head preserves dismissal and completion time through unload or reconnect", () => {
  for (const provider of ["dsh", "codex"]) {
    for (const hidden of [false, true]) {
      for (const previousStatus of ["done", "error", "cancelled"]) {
        const tracker = new ProgressTracker(),
          state = stateFor(),
          row = state.sessions[1];
        row.provider = provider;
        // The previous head may have been seen only in idle metadata.
        row.running = false;
        row.lastTurn = { key: "first", status: previousStatus };
        tracker.sync(state, 100);
        assert.equal(tracker.entries.has("back"), false);
        tracker.start("back", "second");
        row.running = true;
        row.lastTurn = { key: "second", status: "thinking" };
        tracker.sync(state, 200);
        row.running = false;
        row.lastTurn.status = "done";
        tracker.sync(state, 300);
        if (hidden) tracker.dismiss("back");
        const before = { ...tracker.sync(state, 400).back };
        row.runningKnown = false;
        delete row.lastTurn;
        tracker.sync(state, 500);
        row.runningKnown = true;
        row.readOnly = true;
        row.lastTurn = { key: "first", status: previousStatus };
        for (const now of [600, 700, 800]) {
          state.progressEntries = tracker.sync(state, now);
          assert.deepEqual(state.progressEntries.back, before);
          assert.equal(activeProgressItems(state).length, hidden ? 0 : 1);
        }
        // New work completed while disconnected must still reopen the bubble.
        row.lastTurn = { key: "third", status: "done" };
        state.progressEntries = tracker.sync(state, 900);
        assert.equal(state.progressEntries.back.hidden, false);
        assert.equal(state.progressEntries.back.turn, "third");
        assert.equal(state.progressEntries.back.completedAt, 900);
      }
    }
  }
});

test("rollback beyond 64 observed turns preserves dismissal and completion order", () => {
  for (const provider of ["dsh", "codex"]) {
    for (const hidden of [false, true]) {
      const tracker = new ProgressTracker(),
        state = stateFor(),
        row = state.sessions[1];
      row.provider = provider;
      for (let turn = 0; turn < 66; turn++) {
        const key = JSON.stringify(`turn-${turn}`);
        tracker.start(row.sessionId, key);
        row.running = false;
        row.lastTurn = { key, status: "done" };
        tracker.sync(state, turn + 1);
      }
      if (hidden) tracker.dismiss(row.sessionId);
      const before = { ...tracker.sync(state, 100).back };
      // A reconnect to old history need not provide ancestry or timestamps.
      row.runningKnown = false;
      delete row.lastTurn;
      tracker.sync(state, 200);
      row.runningKnown = true;
      row.readOnly = provider === "codex";
      row.lastTurn = { key: JSON.stringify("turn-0"), status: "done" };
      for (const now of [300, 400]) {
        state.progressEntries = tracker.sync(state, now);
        assert.deepEqual(state.progressEntries.back, before);
        assert.equal(activeProgressItems(state).length, hidden ? 0 : 1);
      }
      // Keeping old identities must still allow genuinely new completed work.
      row.lastTurn = { key: JSON.stringify("new-turn"), status: "done" };
      state.progressEntries = tracker.sync(state, 500);
      assert.equal(state.progressEntries.back.hidden, false);
      assert.equal(state.progressEntries.back.completedAt, 500);
      tracker.forget((id) => id === row.sessionId);
      assert.equal(tracker.knownTurns.has(row.sessionId), false);
    }
  }
});

test("rolling back an active task clears running without treating old completion as new work", () => {
  const tracker = new ProgressTracker(),
    state = stateFor(),
    row = state.sessions[1];
  row.lastTurn = { key: "first", status: "done" };
  row.running = false;
  tracker.sync(state);
  tracker.start("back", "second");
  row.lastTurn = { key: "second", status: "thinking" };
  row.running = true;
  tracker.sync(state);
  tracker.dismiss("back");
  row.running = false;
  row.lastTurn = { key: "first", status: "done" };
  state.progressEntries = tracker.sync(state);
  assert.equal(state.progressEntries.back.active, false);
  assert.equal(state.progressEntries.back.hidden, true);
  assert.equal(state.progressEntries.back.completedAt, undefined);
  // Explicit live resumption is work even if that identity was seen before.
  tracker.start("back", "first");
  row.running = true;
  state.progressEntries = tracker.sync(state);
  assert.equal(state.progressEntries.back.hidden, false);
  assert.equal(state.progressEntries.back.active, true);
});

test("an unknown historical head preserves visible or dismissed work until a verified new task arrives", () => {
  for (const hidden of [false, true]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.lastTurn = { key: "latest-observed", status: "thinking" };
    tracker.sync(state, 100);
    row.running = false;
    row.lastTurn.status = "done";
    tracker.sync(state, 200);
    if (hidden) tracker.dismiss(row.sessionId);
    const before = { ...tracker.sync(state, 250).back };
    row.readOnly = true;
    row.lastTurn = {
      key: "never-cached-ancestor",
      status: "error",
      historical: true,
    };
    for (const now of [300, 400, 500]) {
      state.progressEntries = tracker.sync(state, now);
      assert.deepEqual(state.progressEntries.back, before);
      assert.equal(activeProgressItems(state).length, hidden ? 0 : 1);
    }
    row.lastTurn = { key: "verified-new", status: "done" };
    state.progressEntries = tracker.sync(state, 600);
    assert.equal(state.progressEntries.back.hidden, false);
    assert.equal(state.progressEntries.back.completedAt, 600);
  }
});

test("rollback cannot complete unidentified status-only work with an old task's success", () => {
  const tracker = new ProgressTracker(),
    state = stateFor(),
    row = state.sessions[1];
  tracker.sync(state, 100);
  tracker.dismiss(row.sessionId);
  row.running = false;
  row.readOnly = true;
  row.lastTurn = { key: "old-unloaded-head", status: "done", historical: true };
  state.progressEntries = tracker.sync(state, 200);
  assert.deepEqual(state.progressEntries.back, {
    active: false,
    hidden: true,
    turn: null,
    status: "idle",
  });
});

test("remembered history is scoped to a session and removed with its connection or metadata", () => {
  for (const cleanup of ["forget", "prune"]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.lastTurn = { key: "old-head", status: "done" };
    row.running = false;
    tracker.sync(state);
    const other = state.sessions[0];
    other.lastTurn = { key: "other-head", status: "thinking" };
    other.running = true;
    tracker.sync(state);
    tracker.dismiss("front");
    other.running = false;
    other.lastTurn = { key: "old-head", status: "done" };
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.front.hidden, false);
    if (cleanup === "forget") tracker.forget((id) => id === "back");
    else tracker.prune([other]);
    // Reusing an identifier on a fresh connection starts a new lifecycle.
    row.lastTurn = { key: "fresh-head", status: "thinking" };
    row.running = true;
    tracker.sync(state);
    tracker.dismiss("back");
    row.running = false;
    row.lastTurn = { key: "old-head", status: "done" };
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.back.hidden, false);
  }
});

test("read-only history restores a new finished turn only for an existing bubble and respects its dismissal", () => {
  const tracker = new ProgressTracker(),
    state = stateFor(),
    row = state.sessions[1];
  row.lastTurn = { key: "first", status: "thinking" };
  state.progressEntries = tracker.sync(state);
  tracker.dismiss("back");
  row.running = false;
  row.readOnly = true;
  row.lastTurn = { key: "first", status: "done" };
  state.progressEntries = tracker.sync(state);
  assert.equal(
    activeProgress(state),
    null,
    "unloading the same task does not reopen it",
  );
  state.activity.back = { status: "error" }; // Old connection's stale terminal state.
  row.lastTurn = { key: "second", status: "done" };
  state.sessions[0].readOnly = true;
  state.sessions[0].lastTurn = { key: "unobserved-history", status: "done" };
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state).sessionId, "back");
  assert.equal(activeProgress(state).label, "已完成");
  assert.equal(state.progressEntries.front, undefined);
  tracker.dismiss("back");
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state), null);
});

test("a reattached task dismissed with a verified or unknown identity stays closed on completion", () => {
  for (const known of [true, false]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.lastTurn = { key: "first", status: "thinking" };
    tracker.sync(state);
    row.running = false;
    row.readOnly = true;
    row.lastTurn.status = "done";
    tracker.sync(state);
    tracker.dismiss("back");
    row.running = true;
    row.readOnly = false;
    row.lastTurn = known ? { key: "second", status: "thinking" } : undefined;
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state).label, "正在思考");
    tracker.dismiss("back");
    row.running = false;
    row.lastTurn = { key: "second", status: "done" };
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.back.turn, "second");
    assert.equal(activeProgress(state), null);
  }
});

test("status-only work cannot inherit a previous turn's successful result", () => {
  const tracker = new ProgressTracker(),
    state = stateFor(),
    row = state.sessions[1];
  row.lastTurn = { key: "old", status: "done" };
  state.activity.back = { status: "thinking" };
  state.progressEntries = tracker.sync(state);
  row.running = false;
  state.activity.back = { status: "idle" };
  state.progressEntries = tracker.sync(state);
  assert.equal(activeProgress(state).label, "本轮已结束");
});

test("unlisted live turns retain their terminal state until eligible metadata arrives", () => {
  for (const provider of ["dsh", "codex"]) {
    const tracker = new ProgressTracker(),
      state = stateFor();
    state.sessions = [];
    tracker.start("new", "turn-1", false);
    tracker.end("new", "done");
    // Another source's list and transient activity reset cannot erase the turn.
    tracker.prune([]);
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null);
    state.sessions = [{ sessionId: "new", provider, running: false }];
    tracker.prune(state.sessions);
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state).label, "已完成");
    tracker.dismiss("new");
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null);
    state.sessions[0].running = true;
    tracker.start("new", "turn-2");
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state).sessionId, "new");
  }
});

test("newly observed finished tasks survive their first read-only metadata and preserve dismissal", () => {
  for (const hidden of [false, true]) {
    const tracker = new ProgressTracker(),
      state = stateFor();
    state.sessions = [];
    tracker.start("fast", "turn-1", false);
    tracker.end("fast", "done");
    if (hidden) tracker.dismiss("fast");
    tracker.prune([]); // Another provider's list arrives first.
    state.sessions = [
      {
        sessionId: "fast",
        readOnly: true,
        running: false,
        metadataRevision: 1,
      },
    ];
    // The live end is enough even if historical turn hydration is unavailable.
    tracker.prune(state.sessions);
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.fast.status, "done");
    assert.equal(state.progressEntries.fast.hidden, hidden);
    assert.equal(activeProgressItems(state).length, hidden ? 0 : 1);
    tracker.dismiss("fast");
    state.sessions[0].lastTurn = { key: "turn-1", status: "done" };
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null);
    tracker.start("fast", "turn-2", false, 1);
    tracker.end("fast", "error");
    state.progressEntries = tracker.sync(state);
    assert.equal(
      activeProgress(state),
      null,
      "cached metadata cannot confirm the next task",
    );
    state.sessions[0].metadataRevision = 2;
    state.sessions[0].lastTurn = { key: "turn-2", status: "error" };
    tracker.prune(state.sessions);
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state).label, "执行出错");
  }
});

test("restored terminal state and text survive repeated refreshes without using the prior turn's activity", () => {
  for (const [oldStatus, status, label] of [
    ["error", "done", "已完成"],
    ["done", "error", "执行出错"],
    ["error", "error", "执行出错"],
    ["done", "cancelled", "已停止"],
  ]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.lastTurn = { key: "old", status: "thinking" };
    tracker.sync(state);
    row.running = false;
    row.lastTurn.status = oldStatus;
    state.activity.back = {
      turn: "old",
      seq: 10,
      status: oldStatus,
      message: "old error detail",
    };
    tracker.sync(state);
    tracker.dismiss("back");
    row.lastTurn = { key: "new", status };
    for (let i = 0; i < 3; i++) {
      state.activity.back = reconcileSessionActivity(state.activity.back, row);
      state.progressEntries = tracker.sync(state);
      assert.equal(activeProgress(state).label, label);
      assert.equal(activeProgress(state).text, label);
      assert.equal(state.activity.back.seq, 10);
    }
    tracker.dismiss("back");
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null);
  }
});

test("provisional work cannot surface subagents, unobserved history, deleted or replaced sessions", () => {
  const tracker = new ProgressTracker(),
    state = stateFor();
  for (const id of ["child", "deleted", "replaced", "keep"]) {
    tracker.start(id, "turn-1", false);
    tracker.end(id, "done");
  }
  const ineligible = [
    { sessionId: "child", origin: "subagent", running: false },
    { sessionId: "external", readOnly: true, running: false },
  ];
  tracker.prune(ineligible);
  tracker.forget((id) => ["deleted", "replaced"].includes(id));
  // Later metadata or an ID reused by another connection must not revive it.
  state.sessions = ["child", "external", "deleted", "replaced", "keep"].map(
    (sessionId) => ({ sessionId, running: false }),
  );
  state.progressEntries = tracker.sync(state);
  assert.deepEqual(
    activeProgressItems(state).map((row) => row.sessionId),
    ["keep"],
  );
  tracker.forget((id) => id === "keep");
  state.progressEntries = tracker.sync(state);
  assert.deepEqual(activeProgressItems(state), []);
});

test("resumed read-only sessions wait for fresh metadata without losing fast turns", () => {
  for (const finishBeforeMetadata of [true, false]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.provider = "codex";
    row.metadataRevision = 1;
    tracker.start("back", "old");
    tracker.sync(state);
    row.running = false;
    state.activity.back = { status: "done" };
    tracker.sync(state);
    tracker.dismiss("back");
    row.readOnly = true;
    row.metadataRevision = 2;
    tracker.start("back", "resumed", false, row.metadataRevision);
    row.running = true;
    if (finishBeforeMetadata) {
      tracker.end("back", "done");
      row.running = false;
    }
    // Repeated broadcasts and another provider's lists still contain the old
    // read-only row. They must neither promote nor discard the new lifecycle.
    for (let i = 0; i < 3; i++) {
      tracker.prune(state.sessions);
      state.progressEntries = tracker.sync(state);
      assert.equal(activeProgress(state), null);
      assert.equal(state.progressEntries.back.turn, "old");
    }
    row.readOnly = false;
    row.metadataRevision = 3;
    tracker.prune(state.sessions);
    state.progressEntries = tracker.sync(state);
    assert.equal(state.progressEntries.back.turn, "resumed");
    assert.equal(state.progressEntries.back.active, !finishBeforeMetadata);
    assert.equal(state.progressEntries.back.hidden, false);
    assert.equal(activeProgress(state).sessionId, "back");
    if (finishBeforeMetadata)
      assert.equal(activeProgress(state).label, "已完成");
    tracker.dismiss("back");
    state.progressEntries = tracker.sync(state);
    assert.equal(activeProgress(state), null);
  }
});

test("pending resumed turns respect dismissal, unload and fresh subagent metadata", () => {
  for (const outcome of ["dismiss", "readOnly", "subagent", "nextTurn"]) {
    const tracker = new ProgressTracker(),
      state = stateFor(),
      row = state.sessions[1];
    row.readOnly = true;
    row.running = false;
    row.metadataRevision = 2;
    tracker.start("back", "resumed", false, row.metadataRevision);
    tracker.end("back", "done");
    if (outcome === "dismiss") tracker.dismiss("back");
    row.metadataRevision = 3;
    row.readOnly = outcome === "readOnly";
    if (outcome === "subagent") row.origin = "subagent";
    if (outcome === "nextTurn") {
      row.running = true;
      tracker.start("back", "next");
    }
    tracker.prune(state.sessions);
    state.progressEntries = tracker.sync(state);
    if (outcome === "nextTurn") {
      assert.equal(state.progressEntries.back.turn, "next");
      assert.equal(activeProgress(state).sessionId, "back");
    } else if (outcome === "readOnly") {
      assert.equal(activeProgress(state).label, "已完成");
      tracker.dismiss("back");
      state.progressEntries = tracker.sync(state);
    } else assert.equal(activeProgress(state), null);
    // Reloading must respect dismissal, and fresh subagent metadata still
    // rejects provisional work permanently.
    row.readOnly = false;
    delete row.origin;
    row.metadataRevision = 4;
    state.progressEntries = tracker.sync(state);
    if (outcome !== "nextTurn") assert.equal(activeProgress(state), null);
  }
});
