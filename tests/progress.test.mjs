import test from "node:test";
import assert from "node:assert/strict";
import { activeProgress, activeProgressItems } from "../shared/progress.mjs";
import { reduceActivity } from "../shared/activity.mjs";
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
