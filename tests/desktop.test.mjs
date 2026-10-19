import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { once } from "node:events";
import { desktopBridge } from "../plugins/dsh-girl/desktop-bridge.mjs";
import { DshClient } from "../shared/dsh-client.mjs";
import { reduceAssistantStream } from "../shared/assistant-stream.mjs";

function fixture() {
  const listeners = new Map(),
    calls = [];
  const peer = {
    principal: { kind: "owner" },
    dispose: async () => {
      peer.disposed = true;
    },
  };
  let publish;
  const gateway = {
    async invoke(call) {
      assert.equal(call.peer, peer);
      calls.push(call);
      if (call.method === "list") {
        assert.deepEqual(call.args, { _request: {} });
        return { items: [{ sessionId: "s1", running: false }] };
      }
      if (call.method === "page")
        return { records: [{ event: { seq: 1 } }], hasMore: true };
      return { sessionId: "s1" };
    },
    async stream(call) {
      assert.equal(call.method, "follow");
      return (async function* () {
        try {
          yield {
            type: "snapshot",
            cursor: 9,
            records: [{ event: { seq: 9 } }],
            hasMore: false,
            projections: { asOfSeq: 9, values: {} },
          };
        } finally {
          gateway.followClosed = true;
        }
      })();
    },
    wireStream: {
      async open(endpoint, payload, uplink, gotPeer, signal) {
        assert.equal(endpoint, "$events");
        assert.equal(gotPeer, peer);
        const queue = [];
        let wake;
        publish = (value) => {
          queue.push(value);
          wake?.();
        };
        return (async function* () {
          yield { type: "ready", clientId: "client" };
          const aborted = () => wake?.();
          signal.addEventListener("abort", aborted);
          try {
            while (!signal.aborted) {
              if (!queue.length)
                await new Promise((resolve) => {
                  wake = resolve;
                });
              while (queue.length) yield queue.shift();
            }
          } finally {
            signal.removeEventListener("abort", aborted);
          }
        })();
      },
    },
    async dispatchRpc(endpoint, payload, signal, gotPeer) {
      assert.equal(gotPeer, peer);
      calls.push({ endpoint, payload });
      return { ok: true };
    },
  };
  return {
    ctx: {
      get: () => gateway,
      connection: { createPeer: () => peer },
      credentials: { resolve: async () => null },
      on: (event, fn) => {
        listeners.set(event, fn);
        return () => listeners.delete(event);
      },
    },
    calls,
    gateway,
    peer,
    publish: (value) => publish(value),
    emit: (event, ...args) => listeners.get(event)?.(...args),
    listeners,
  };
}

test("Desktop bridge authenticates HTTP and sockets, translates history and keeps the same owner Peer for human decisions", async () => {
  const host = fixture(),
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
    assert.equal((await client.connect()).version, "desktop-0.2");
    await connected;
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
