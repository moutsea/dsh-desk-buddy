import test from "node:test";
import assert from "node:assert/strict";
import { DshClient, normalizeEndpoint } from "../shared/dsh-client.mjs";
import { mergeEvents, projectSession } from "../shared/projection.mjs";
import { createFixture } from "./fixture.mjs";

test("only plain loopback HTTP endpoints are accepted", () => {
  assert.equal(
    normalizeEndpoint("http://127.0.0.1:3080/"),
    "http://127.0.0.1:3080",
  );
  assert.equal(normalizeEndpoint("http://[::1]:3080"), "http://[::1]:3080");
  for (const endpoint of [
    "https://example.com",
    "http://localhost:3080",
    "http://127.0.0.1:3080/evil",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1/?token=1",
    "http://127.0.0.1/#x",
  ])
    assert.throws(() => normalizeEndpoint(endpoint));
});
test("WebSocket handles fragmented Chinese UTF-8 messages", async () => {
  const fixture = await createFixture(),
    client = new DshClient(fixture.endpoint);
  try {
    const connected = new Promise((resolve) =>
      client.on("stream", () => {
        if (client.streams.size === 2) resolve();
      }),
    );
    await client.connect();
    await connected;
    const received = new Promise((resolve) => client.once("frame", resolve));
    fixture.fragment("mux", {
      type: "session/subscribed",
      sessionId: "你好",
      lastSeq: -1,
    });
    assert.equal((await received).payload.sessionId, "你好");
  } finally {
    client.close();
    await fixture.close();
  }
});
test("final messages replace streamed partials; snapshots do not erase new events", () => {
  const start = { seq: 0, type: "turn/start", data: { turn: 1 } };
  const chunk = {
    seq: 2,
    type: "assistant/chunk",
    data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "你" } },
  };
  const final = {
    seq: 3,
    type: "assistant/message",
    surfaceOp: "append",
    data: {
      turn: 1,
      step: 0,
      message: { content: [{ type: "text", text: "你好" }] },
    },
  };
  const end = {
    seq: 4,
    type: "turn/end",
    data: { turn: 1, reason: { kind: "aborted" } },
  };
  const events = mergeEvents([start, chunk, final, end], [start, chunk]);
  assert.equal(events.length, 4);
  const result = projectSession(events, false);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "你好");
  assert.equal(result.messages[0].streaming, false);
  assert.equal(result.status, "cancelled");
  const resumed = projectSession(
    [
      ...events,
      {
        seq: 5,
        type: "assistant/chunk",
        data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "继续" } },
      },
    ],
    true,
  );
  assert.equal(
    new Set(resumed.messages.map((message) => message.id)).size,
    resumed.messages.length,
  );
});
test("internal injections and model surface replacements are not chat messages", () => {
  const events = [
    {
      seq: 0,
      type: "user/message",
      surfaceOp: "append",
      data: {
        source: { kind: "plugin" },
        content: [{ type: "text", text: "hidden" }],
      },
    },
    {
      seq: 1,
      type: "user/message",
      surfaceOp: { replace: [0] },
      data: { content: [{ type: "text", text: "hidden replacement" }] },
    },
    {
      seq: 2,
      type: "user/message",
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "visible" }],
      },
    },
  ];
  assert.deepEqual(
    projectSession(events).messages.map((item) => item.text),
    ["visible"],
  );
  assert.equal(
    projectSession([
      { seq: 0, type: "turn/end", data: { reason: { kind: "error" } } },
    ]).status,
    "error",
  );
});
test("real HTTP RPC, business errors, question and approval response envelopes", async () => {
  const fixture = await createFixture(),
    client = new DshClient(fixture.endpoint);
  try {
    const host = await client.connect();
    assert.equal(host.version, "fixture-1");
    const { sessionId } = await client.rpc("session.create", {
      cwd: "/tmp/project",
    });
    await assert.rejects(
      () =>
        client.rpc("session.prompt", {
          sessionId,
          content: [{ type: "text", text: "触发失败" }],
          mode: "queue",
        }),
      /拒绝/,
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "session.prompt").length,
      1,
    );
    fixture.pending.set("test-approval", {
      type: "approval/requested",
      sessionId,
      approvalId: "approval-test",
    });
    await client.respond("test-approval", {
      sessionId,
      approvalId: "approval-test",
      outcome: "allowed-once",
    });
    const response = fixture.calls.find((call) => call.path === "/api/respond");
    assert.equal(response.type, "client-response");
    assert.equal(response.rpcId, "test-approval");
    assert.equal(response.result.value.outcome, "allowed-once");
    await assert.rejects(() => client.respond("expired", {}), /失效/);
  } finally {
    client.close();
    await fixture.close();
  }
});
test("streams reconnect and replay pending interactions without resubmitting prompts", async () => {
  const fixture = await createFixture(),
    client = new DshClient(fixture.endpoint);
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error("timeout"));
      }, 5000);
      const timer = setInterval(() => {
        if (predicate()) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
  const states = [],
    frames = [],
    starts = [];
  client.on("stream-start", ({ kind }) => starts.push(kind));
  client.on("stream", (value) => {
    if (value.connected)
      assert.ok(
        starts.filter((kind) => kind === value.kind).length >
          states.filter(
            (previous) => previous.kind === value.kind && previous.connected,
          ).length,
        "each subscription reserves order before its open event or baseline",
      );
    states.push(value);
  });
  client.on("frame", (frame) => frames.push(frame));
  try {
    await client.connect();
    await wait(() => client.streams.size === 2);
    fixture.pending.set("pending-replay", {
      type: "question/requested",
      sessionId: "test",
      questions: [],
    });
    fixture.dropStreams();
    await wait(() => frames.some((frame) => frame.rpcId === "pending-replay"));
    assert.ok(states.some((value) => !value.connected));
    assert.equal(starts.filter((kind) => kind === "mux").length, 2);
    assert.equal(
      fixture.calls.filter((call) => call.method === "session.prompt").length,
      0,
    );
  } finally {
    client.close();
    await fixture.close();
  }
});
