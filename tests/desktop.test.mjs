import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { once } from "node:events";
import { desktopBridge } from "../plugins/dsh-girl/desktop-bridge.mjs";
import { DshClient } from "../shared/dsh-client.mjs";
import { reduceAssistantStream } from "../shared/assistant-stream.mjs";
import {
  setAssistantStream,
  setHistoryEvents,
} from "../electron/history-state.mjs";
import { mergeEvents } from "../shared/projection.mjs";

import { desktopHost } from "./helpers/desktop-host.mjs";

for (const historyFirst of [false, true])
  test(
    `Desktop mid-turn connections keep a stream received before any durable event; history first = ${historyFirst}`,
    { timeout: 5000 },
    async (t) => {
      const host = desktopHost();
      const events = [
        { seq: 20, type: "turn/start", data: { turn: 2 } },
        { seq: 21, type: "step/start", data: { turn: 2, step: 0 } },
      ];
      const original = host.gateway.stream.bind(host.gateway);
      host.gateway.stream = async (call) =>
        call.method === "follow"
          ? (async function* () {
              yield {
                type: "snapshot",
                cursor: 21,
                records: events.map((event) => ({ event })),
                hasMore: false,
              };
            })()
          : original(call);
      const bridge = await desktopBridge(host.ctx);
      const client = new DshClient(bridge.endpoint, { token: bridge.token });
      t.after(async () => {
        client.close();
        await bridge.dispose();
      });
      const state = {
        selectedId: "s1",
        events: [],
        eventsRevision: 0,
        liveAssistant: {},
        hasMore: false,
      };
      client.on("frame", ({ payload }) => {
        if (payload.type === "session/event")
          setHistoryEvents(state, mergeEvents(state.events, [payload.event]));
        if (payload.type === "session/assistant-stream")
          setAssistantStream(state, payload.sessionId, payload.frame);
      });
      const deliver = async (event, ...args) => {
        const delivered = new Promise((resolve) => {
          const listener = ({ payload }) => {
            if (payload.sessionId !== "s1") return;
            client.off("frame", listener);
            resolve();
          };
          client.on("frame", listener);
        });
        host.emit(event, ...args);
        await delivered;
      };
      const connected = new Promise((resolve) =>
        client.on("stream", () => {
          if (client.streams.size === 2) resolve();
        }),
      );
      await client.connect();
      await connected;
      const snapshot = async () =>
        setHistoryEvents(
          state,
          (await client.rpc("session.history", { sessionId: "s1" })).events.map(
            ({ event }) => event,
          ),
        );
      if (historyFirst) await snapshot();
      // The private bridge does not replay the already-persisted turn/step
      // events on a new mux socket. Its first frame may be an assistant start.
      for (const frame of [
        { type: "start", attemptId: "s1:2", revision: 8, turn: 2, step: 0 },
        {
          type: "chunk",
          attemptId: "s1:2",
          revision: 9,
          index: 0,
          chunk: { type: "text-delta", index: 0, text: "Still running" },
        },
      ])
        await deliver("agent/assistant-stream", {
          agent: { session: { id: "s1" } },
          frame,
        });
      if (!historyFirst) await snapshot();
      assert.equal(state.liveAssistant.s1?.text, "Still running");
      await snapshot();
      assert.equal(state.liveAssistant.s1?.text, "Still running");
      await deliver(
        "session/event",
        { id: "s1" },
        {
          seq: 22,
          type: "assistant/message",
          data: {
            turn: 2,
            step: 0,
            message: { content: [{ type: "text", text: "Still running" }] },
          },
        },
      );
      assert.equal(state.liveAssistant.s1, null);
      assert.equal(state.events.at(-1).data.attemptId, "s1:2");
    },
  );

test("Desktop bridge exposes the host model catalog and forwards session selections", async () => {
  const host = desktopHost(),
    bridge = await desktopBridge(host.ctx);
  const client = new DshClient(bridge.endpoint, { token: bridge.token });
  try {
    await client.connect();
    host.sessions.get("s1").projections = {
      asOfSeq: 9,
      values: {
        modelSelection: {
          lastUsed: { provider: "deepseek", model: "deepseek-v4.1-flash" },
          next: {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            reasoningEffort: "high",
          },
        },
      },
    };
    assert.deepEqual(await client.rpc("session.models", { sessionId: "s1" }), {
      current: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
      routable: true,
      groups: [
        {
          id: "deepseek",
          name: "DeepSeek",
          models: [
            { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
          ],
        },
      ],
      failures: [],
    });
    const selection = {
      sessionId: "s1",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    };
    assert.deepEqual(await client.rpc("session.selectModel", selection), {
      selected: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
    });
    const call = host.calls.at(-1);
    assert.equal(call.namespace, "session");
    assert.equal(call.method, "selectModel");
    assert.deepEqual(call.args, { request: selection });
    assert.equal(call.peer, host.peer);
  } finally {
    client.close();
    await bridge.dispose();
  }
});

test("Desktop model lookup surfaces projection failures for retry", async () => {
  const host = desktopHost();
  const originalInvoke = host.gateway.invoke.bind(host.gateway);
  host.gateway.invoke = async (call) => {
    if (call.method === "projections") throw new Error("projection temporarily unavailable");
    return originalInvoke(call);
  };
  const bridge = await desktopBridge(host.ctx);
  const client = new DshClient(bridge.endpoint, { token: bridge.token });
  try {
    await client.connect();
    await assert.rejects(
      client.rpc("session.models", { sessionId: "s1" }),
      /projection temporarily unavailable/,
    );
  } finally {
    client.close();
    await bridge.dispose();
  }
});

test("Desktop bridge authenticates HTTP and sockets, translates history and keeps the same owner Peer for human decisions", async () => {
  const host = desktopHost(),
    bridge = await desktopBridge(host.ctx);
  const client = new DshClient(bridge.endpoint, { token: bridge.token });
  try {
    assert.equal(
      (await fetch(bridge.endpoint + "/api/host.describe", { method: "POST" }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(bridge.endpoint + "/api/host.describe", {
          method: "POST",
          headers: {
            "X-DSG-Token": bridge.token,
            Origin: "https://example.test",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(bridge.endpoint + "/api/host.describe", {
          method: "POST",
          headers: { "X-DSG-Token": "é".repeat(64) },
        })
      ).status,
      403,
    );
    const unauthorized = new WebSocket(
      bridge.endpoint.replace("http:", "ws:") + "/api/events.mux",
    );
    assert.match((await once(unauthorized, "error"))[0].message, /403/);
    const connected = new Promise((resolve) =>
      client.on("stream", () => {
        if (client.streams.size === 2) resolve();
      }),
    );
    const baseline = once(client, "frame");
    assert.equal((await client.connect()).version, "desktop-0.2");
    await connected;
    assert.equal((await baseline)[0].payload.type, "session/projections");
    assert.equal((await client.rpc("session.list")).items[0].sessionId, "s1");
    assert.equal(
      (await client.rpc("session.history", { sessionId: "s1", beforeSeq: 5 }))
        .events[0].event.seq,
      1,
    );
    assert.equal(host.gateway.followClosed, true);
    await client.rpc("session.prompt", {
      sessionId: "s1",
      content: [{ type: "text", text: "test" }],
    });
    assert.equal(typeof host.calls.at(-1).args.request.requestId, "string");
    const event = once(client, "frame");
    host.emit(
      "session/event",
      { id: "s1" },
      { type: "turn/end", seq: 12, data: { reason: { kind: "completed" } } },
    );
    assert.equal((await event)[0].payload.event.seq, 12);
    const approval = once(client, "frame");
    host.publish({
      type: "waterfall",
      event: "approval/request",
      eventId: "approval-1",
      agentId: "s1",
      request: { toolName: "bash", reason: "test" },
    });
    const frame = (await approval)[0];
    assert.equal(frame.payload.approvalId, "approval-1");
    await assert.rejects(
      client.respond("approval-1", {
        sessionId: "other",
        approvalId: "approval-1",
        outcome: "allowed-once",
      }),
      /已处理|失效/,
    );
    await client.respond("approval-1", {
      sessionId: "s1",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });
    assert.deepEqual(host.calls.at(-1).payload.args, {
      clientId: "client",
      eventId: "approval-1",
      outcome: { kind: "result", value: "allowed-once" },
    });
    const question = once(client, "frame");
    host.publish({
      type: "waterfall",
      event: "user-questions/request",
      eventId: "question-1",
      agentId: "s1",
      request: { questions: [{ id: "q", question: "Which?" }] },
    });
    await question;
    await client.respond("question-1", {
      sessionId: "s1",
      answer: { answers: [{ id: "q", custom: "A", selected: [] }] },
    });
    assert.equal(
      host.calls.at(-1).payload.args.outcome.value.answers[0].custom,
      "A",
    );
    await assert.rejects(client.rpc("arbitrary.command"), /不支持/);
  } finally {
    client.close();
    await bridge.dispose();
  }
  assert.equal(host.peer.disposed, true);
  assert.equal(host.listeners.size, 0);
});

test(
  "Desktop control forwards baseline and live projections, then resubscribes after stream EOF",
  { timeout: 10000 },
  async () => {
    const host = desktopHost();
    const row = host.sessions.get("s1");
    row.projections = {
      asOfSeq: 10,
      values: { tokenUsage: { outputTokens: 12 } },
    };
    const bridge = await desktopBridge(host.ctx);
    const client = new DshClient(bridge.endpoint, { token: bridge.token });
    try {
      const baseline = once(client, "frame");
      await client.connect();
      assert.deepEqual((await baseline)[0].payload, {
        type: "session/projections",
        projections: { s1: row.projections },
      });
      const delta = {
        type: "projection",
        sessionId: "s1",
        key: "tokenUsage",
        value: { outputTokens: 24 },
        seq: 11,
      };
      const live = once(client, "frame");
      host.publishControl(delta);
      assert.deepEqual((await live)[0].payload, {
        ...delta,
        type: "session/projection",
      });

      // A host restart can reset its sequence. EOF must trigger a new subscription.
      row.projections = {
        asOfSeq: 1,
        values: { tokenUsage: { outputTokens: 3 } },
      };
      const reconnect = once(client, "frame");
      host.endControl();
      assert.deepEqual((await reconnect)[0].payload, {
        type: "session/projections",
        projections: { s1: row.projections },
      });
      assert.equal(
        host.calls.filter((call) => call.method === "control").length,
        2,
      );
      assert.equal(host.controls.size, 1);
    } finally {
      client.close();
      await bridge.dispose();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.controls.size, 0);
  },
);

test(
  "Desktop events EOF closes mux and reconnects before forwarding human requests",
  { timeout: 10000 },
  async () => {
    const host = desktopHost();
    const originalOpen = host.gateway.wireStream.open.bind(host.gateway.wireStream);
    let opens = 0;
    let release;
    host.gateway.wireStream.open = async (...args) => {
      opens++;
      if (opens !== 1) return originalOpen(...args);
      const signal = args[4];
      return (async function* () {
        yield { type: "ready", clientId: "first-client" };
        await new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      })();
    };
    const bridge = await desktopBridge(host.ctx);
    const client = new DshClient(bridge.endpoint, { token: bridge.token });
    const connected = () =>
      new Promise((resolve) => {
        const onStream = () => {
          if (client.streams.size === 2) {
            client.off("stream", onStream);
            resolve();
          }
        };
        client.on("stream", onStream);
      });
    try {
      const initial = connected();
      await client.connect();
      await initial;
      const disconnected = new Promise((resolve) => {
        const onStream = ({ kind, connected: value }) => {
          if (kind === "mux" && value === false) {
            client.off("stream", onStream);
            resolve();
          }
        };
        client.on("stream", onStream);
      });
      release();
      await disconnected;
      const reconnected = connected();
      await reconnected;
      assert.equal(opens, 2);
      const approval = once(client, "frame");
      host.publish({
        type: "waterfall",
        event: "approval/request",
        eventId: "after-eof",
        agentId: "s1",
        request: { toolName: "bash", reason: "after reconnect" },
      });
      assert.equal((await approval)[0].payload.approvalId, "after-eof");
    } finally {
      client.close();
      await bridge.dispose();
    }
  },
);

test("Desktop bridge disposal aborts active event streams without reporting an error", async () => {
  const host = desktopHost();
  host.gateway.wireStream.open = async (...args) => {
    const signal = args[4];
    return (async function* () {
      yield { type: "ready", clientId: "dispose-client" };
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    })();
  };
  const bridge = await desktopBridge(host.ctx);
  const client = new DshClient(bridge.endpoint, { token: bridge.token });
  try {
    await client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    await bridge.dispose();
    assert.equal(bridge.error, "");
    assert.equal(host.peer.disposed, true);
  } finally {
    client.close();
  }
});

test("Desktop cursorless streaming drops duplicates and gaps without changing durable event cursors", () => {
  let stream = reduceAssistantStream(null, {
    type: "start",
    attemptId: "a",
    revision: 1,
  });
  stream = reduceAssistantStream(stream, {
    type: "chunk",
    attemptId: "a",
    revision: 2,
    chunk: { type: "text-delta", text: "你好" },
  });
  assert.equal(stream.text, "你好");
  assert.equal(
    reduceAssistantStream(stream, {
      type: "start",
      attemptId: "a",
      revision: 1,
    }),
    stream,
  );
  assert.equal(
    reduceAssistantStream(stream, {
      type: "chunk",
      attemptId: "a",
      revision: 2,
    }),
    stream,
  );
  assert.equal(
    reduceAssistantStream(stream, {
      type: "chunk",
      attemptId: "a",
      revision: 4,
    }),
    null,
  );
  assert.equal(
    reduceAssistantStream(stream, { type: "end", attemptId: "a", revision: 3 }),
    null,
  );
});
