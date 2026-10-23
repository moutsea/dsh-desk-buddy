import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  CodexClient,
  normalizeCodexEndpoint,
} from "../shared/codex-client.mjs";
import { CodexTransport } from "../shared/codex-transport.mjs";
import { CodexSession, codexUsage } from "../shared/codex-session.mjs";
import { createRequire } from "node:module";
import { sessionUsage } from "../shared/session-usage.mjs";
import { projectSession } from "../shared/projection.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("timed out");
}
async function setup(t, options, hostOptions) {
  const host = await createCodexHost(hostOptions);
  host.add();
  const client = new CodexClient(host.endpoint, options);
  const frames = [];
  client.on("frame", (f) => frames.push(f));
  t.after(async () => {
    client.close();
    await host.close();
  });
  await client.connect();
  await client.rpc("session.list");
  return { host, client, frames };
}

test("initialize uses the application version and cleans up failed handshakes with structured errors", async (t) => {
  const host = await createCodexHost();
  const transport = new CodexTransport(host.endpoint);
  t.after(async () => {
    transport.close();
    await host.close();
  });
  let socket;
  host.handler = (frame, peer) => {
    if (frame.method !== "initialize") return false;
    socket = peer;
    assert.equal(
      frame.params.clientInfo.version,
      createRequire(import.meta.url)("../package.json").version,
    );
    peer.send(
      JSON.stringify({
        id: frame.id,
        error: {
          code: -32600,
          message: "unrecognized failure",
          data: { detail: "preserved" },
        },
      }),
    );
    return true;
  };
  await assert.rejects(transport.connect(), (error) => {
    assert.equal(error.code, -32600);
    assert.equal(error.method, "initialize");
    assert.deepEqual(error.data, { detail: "preserved" });
    return true;
  });
  assert.equal(transport.closed, true);
  assert.equal(transport.pending.size, 0);
  await until(() => socket.readyState === 3);
});

test("reconnect backs off to a cap, resets after success and stops on close", async (t) => {
  const { client, host } = await setup(t, {
    reconnectDelay: 10,
    reconnectMaxDelay: 40,
    random: () => 1,
  });
  const retries = [];
  client.on("retry", (event) => retries.push(event.delay));
  let failures = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "initialize" || failures++ >= 3) return false;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32603, message: "temporary failure" },
      }),
    );
    return true;
  };
  host.disconnect();
  await until(() => retries.length === 4 && client.streams.size === 2);
  assert.deepEqual(retries, [10, 20, 40, 40]);
  host.disconnect();
  await until(() => retries.length === 5);
  assert.equal(retries.at(-1), 10);
  client.close();
  const calls = host.calls.length;
  await delay(60);
  assert.equal(host.calls.length, calls);
});

test("method-not-found fallback is independent of wording and unknown invalid requests still fail", async (t) => {
  const { host, client } = await setup(t);
  const diagnostics = [];
  client.on("diagnostic", (event) => diagnostics.push(event));
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: {
          code: -32601,
          message: "新的错误文案",
          data: { anything: true },
        },
      }),
    );
    return true;
  };
  await client.history("thread-1", false);
  await client.history("thread-1", false);
  assert(
    host.calls.some(
      (call) => call.method === "thread/read" && call.params.includeTurns,
    ),
  );
  assert.equal(diagnostics.filter((d) => d.kind === "legacy-turns").length, 1);
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32600, message: "unexpected invalid request" },
      }),
    );
    return true;
  };
  await assert.rejects(
    client.history("thread-1", false),
    /unexpected invalid request/,
  );
});

test("new polled threads remain in history after unloading inside the stored-list TTL", async (t) => {
  const { host, client, frames } = await setup(t);
  const lists = () =>
    host.calls.filter((call) => call.method === "thread/list").length;
  const before = lists();
  host.add("polled-new");
  const turn = host.start("polled-new");
  // No thread/started notification: discover it through loaded/list only.
  let rows = (await client.rpc("session.list", { poll: true })).items;
  assert.equal(
    rows.find((row) => row.sessionId === "polled-new").running,
    true,
  );
  assert.equal(lists(), before);
  host.finish("polled-new", turn);
  await until(() =>
    frames.some(
      (frame) =>
        frame.payload.sessionId === "polled-new" &&
        frame.payload.event?.type === "turn/end",
    ),
  );
  host.sessions.get("polled-new").status = { type: "notLoaded" };
  rows = (await client.rpc("session.list", { poll: true })).items;
  assert.equal(
    lists(),
    before + 1,
    "verify stale history before removing an unloaded thread",
  );
  const retained = rows.find((row) => row.sessionId === "polled-new");
  assert.equal(retained.readOnly, true);
  assert.equal(retained.running, false);
  assert(client.sessions.has("polled-new"));
  host.sessions.delete("polled-new");
  rows = (await client.rpc("session.list")).items;
  assert.equal(
    rows.some((row) => row.sessionId === "polled-new"),
    false,
    "fresh deletion is still authoritative",
  );
});

for (const phase of ["later-read", "own-read", "resume", "uncached"]) {
  test(`unload during ${phase} keeps the persisted session read-only in the same list`, async (t) => {
    const { host, client } = await setup(t);
    const id = phase === "uncached" ? "new-polled" : "thread-1";
    if (phase === "uncached") host.add(id);
    if (phase === "resume") {
      host.sessions.get(id).status = { type: "notLoaded" };
      await client.rpc("session.list");
      host.sessions.get(id).status = { type: "idle" };
    }
    host.add("blocker");
    const method = phase === "resume" ? "thread/resume" : "thread/read";
    const blocked = ["later-read", "uncached"].includes(phase) ? "blocker" : id;
    let release, listing, rows;
    host.handler = (frame, socket) => {
      if (frame.method !== method || frame.params.threadId !== blocked) return;
      const thread = { ...host.sessions.get(blocked), turns: [] };
      release = () =>
        socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
      return true;
    };
    try {
      listing = client.rpc("session.list", { poll: phase === "uncached" });
      await until(() => release);
      const turn = host.start(id);
      host.finish(id, turn);
      host.sessions.get(id).status = { type: "notLoaded" };
      host.notify("thread/status/changed", {
        threadId: id,
        status: { type: "notLoaded" },
      });
      await until(
        () => client.sessions.get(id)?.thread.status.type === "notLoaded",
      );
    } finally {
      host.handler = null;
      release?.();
      rows = (await listing).items;
    }
    const retained = rows.find((row) => row.sessionId === id);
    assert(retained, "unloading while another read is pending is not deletion");
    assert.equal(retained.readOnly, true);
    assert.equal(retained.running, false);
    assert.equal(
      client.attached.has(id),
      false,
      "stale reads or resume receipts cannot restore a dead subscription",
    );
    assert.equal(
      client.stored.has(id),
      true,
      "newly polled work verifies history before returning",
    );
    assert.equal(
      host.calls.filter(
        (call) =>
          call.method === "thread/resume" && call.params.threadId === id,
      ).length,
      phase === "resume" ? 2 : 1,
      "unload must not cause another automatic resume",
    );
    const next = (await client.rpc("session.list")).items.find(
      (row) => row.sessionId === id,
    );
    assert.equal(next.readOnly, true);
    host.sessions.delete(id);
    assert.equal(
      (await client.rpc("session.list")).items.some(
        (row) => row.sessionId === id,
      ),
      false,
      "a later verified deletion still removes it",
    );
  });
}

test("failed unload verification preserves the thread until history can be refreshed", async (t) => {
  const { host, client } = await setup(t);
  host.add("new-unloaded");
  await client.rpc("session.list", { poll: true });
  host.sessions.get("new-unloaded").status = { type: "notLoaded" };
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/list") return;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32000, message: "temporary history failure" },
      }),
    );
    return true;
  };
  await assert.rejects(
    client.rpc("session.list", { poll: true }),
    /temporary history failure/,
  );
  assert(client.sessions.has("new-unloaded"));
  host.handler = null;
  const rows = (await client.rpc("session.list", { poll: true })).items;
  assert.equal(
    rows.find((row) => row.sessionId === "new-unloaded").readOnly,
    true,
  );
});

for (const phase of [
  "later-read",
  "history-response",
  "history-pagination",
  "verification-error",
]) {
  test(`owned draft first completion survives an older ${phase} snapshot`, async (t) => {
    const { host, client } = await setup(t, undefined, {
      persistEmptyThreads: false,
    });
    const { sessionId: id } = await client.rpc("session.create", {
      cwd: "/tmp/dsg-codex-test",
    });
    await client.list();
    assert(client.attached.has(id));
    assert.equal(client.stored.has(id), false);
    host.add("blocker");
    let release,
      listing,
      rows,
      reads = 0;
    host.handler = (frame, socket) => {
      if (frame.method === "thread/list") {
        if (!frame.params.cursor) reads++;
        if (phase === "verification-error" && reads === 2) {
          socket.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32000, message: "verification unavailable" },
            }),
          );
          return true;
        }
        if (phase.startsWith("history-") && reads === 1) {
          const result = { data: host.storedThreads(), nextCursor: null };
          if (phase === "history-pagination" && !frame.params.cursor) {
            socket.send(
              JSON.stringify({
                id: frame.id,
                result: { ...result, nextCursor: "last-page" },
              }),
            );
            return true;
          }
          if (frame.params.cursor) result.data = [];
          release = () => socket.send(JSON.stringify({ id: frame.id, result }));
          return true;
        }
      }
      if (
        !phase.startsWith("history-") &&
        frame.method === "thread/read" &&
        frame.params.threadId === "blocker"
      ) {
        const thread = { ...host.sessions.get("blocker"), turns: [] };
        release = () =>
          socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
        return true;
      }
    };
    try {
      listing = client.list();
      await until(() => release);
      const turn = host.start(id);
      host.finish(id, turn);
      host.sessions.get(id).status = { type: "notLoaded" };
      host.notify("thread/status/changed", {
        threadId: id,
        status: { type: "notLoaded" },
      });
      await until(
        () => client.sessions.get(id)?.thread.status.type === "notLoaded",
      );
    } finally {
      release?.();
      try {
        if (phase === "verification-error") {
          await assert.rejects(listing, /verification unavailable/);
          assert(
            client.sessions.has(id),
            "failed verification cannot delete observed work",
          );
        } else rows = (await listing).items;
      } finally {
        host.handler = null;
      }
    }
    assert.equal(
      reads,
      2,
      "verify absence after the first task, even if history was already refreshed",
    );
    if (phase === "verification-error")
      rows = (await client.list({ poll: true })).items;
    const retained = rows.find((row) => row.sessionId === id);
    assert(
      retained,
      "a snapshot preceding materialization is not evidence of deletion",
    );
    assert.equal(retained.readOnly, true);
    assert.equal(retained.running, false);
    assert(client.stored.has(id));
    assert.equal(
      host.calls.filter(
        (call) =>
          call.method === "thread/resume" && call.params.threadId === id,
      ).length,
      0,
    );
    host.sessions.delete(id);
    assert.equal(
      (await client.list()).items.some((row) => row.sessionId === id),
      false,
      "a later verified deletion is still authoritative",
    );
  });
}

test("materialization during history verification is retained until the next snapshot", async (t) => {
  const { host, client } = await setup(t, undefined, {
    persistEmptyThreads: false,
  });
  const first = (
    await client.rpc("session.create", { cwd: "/tmp/dsg-codex-test" })
  ).sessionId;
  const second = (
    await client.rpc("session.create", { cwd: "/tmp/dsg-codex-test" })
  ).sessionId;
  await client.list();
  host.add("blocker");
  let releaseRead,
    releaseHistory,
    listing,
    reads = 0,
    rows;
  host.handler = (frame, socket) => {
    if (frame.method === "thread/list" && ++reads === 2) {
      const result = { data: host.storedThreads(), nextCursor: null };
      releaseHistory = () =>
        socket.send(JSON.stringify({ id: frame.id, result }));
      return true;
    }
    if (frame.method === "thread/read" && frame.params.threadId === "blocker") {
      const thread = { ...host.sessions.get("blocker"), turns: [] };
      releaseRead = () =>
        socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
      return true;
    }
  };
  const complete = async (id) => {
    const turn = host.start(id);
    host.finish(id, turn);
    host.sessions.get(id).status = { type: "notLoaded" };
    host.notify("thread/status/changed", {
      threadId: id,
      status: { type: "notLoaded" },
    });
    await until(
      () => client.sessions.get(id)?.thread.status.type === "notLoaded",
    );
  };
  try {
    listing = client.list();
    await until(() => releaseRead);
    await complete(first);
    releaseRead();
    releaseRead = null;
    await until(() => releaseHistory);
    await complete(second);
  } finally {
    host.handler = null;
    releaseRead?.();
    releaseHistory?.();
    rows = (await listing).items;
  }
  assert.equal(
    reads,
    2,
    "bounded verification cannot loop on ongoing notifications",
  );
  for (const id of [first, second]) {
    const row = rows.find((row) => row.sessionId === id);
    assert(
      row,
      "newer work must survive even the verification snapshot becoming stale",
    );
    assert.equal(row.readOnly, true);
  }
  assert.equal(
    client.stored.has(second),
    false,
    "second materialized after the verification snapshot",
  );
  rows = (await client.list({ poll: true })).items;
  assert.equal(client.stored.has(second), true);
  assert(rows.some((row) => row.sessionId === second && row.readOnly));
});

test("Codex accepts only plain loopback WebSocket endpoints", () => {
  assert.equal(
    normalizeCodexEndpoint("ws://127.0.0.1:4500/"),
    "ws://127.0.0.1:4500",
  );
  for (const value of [
    "ws://example.com",
    "http://127.0.0.1",
    "ws://127.0.0.1/path",
    "ws://u:p@127.0.0.1",
    "ws://127.0.0.1/?token=x",
  ])
    assert.throws(() => normalizeCodexEndpoint(value));
});
test("Codex usage includes cached input and reasoning output exactly once", () => {
  const usage = sessionUsage(
    codexUsage({
      total: {
        inputTokens: 1000,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 100,
        outputTokens: 200,
        reasoningOutputTokens: 150,
        totalTokens: 1200,
      },
      last: { totalTokens: 500 },
      modelContextWindow: 2000,
    }),
  );
  assert.equal(usage.total, 1200);
  assert.equal(usage.uncachedInput, 300);
  assert.equal(usage.cacheHitRate, 0.6);
  assert.equal(usage.contextRate, 0.25);
  assert.equal(usage.tokensPerSecond, null);
  assert.equal(
    sessionUsage(
      codexUsage({
        total: { inputTokens: 100, cachedInputTokens: 200, outputTokens: 5 },
      }),
    ).total,
    null,
  );
});
test("history prepends pages and concurrent live completion wins over stale history", () => {
  const s = new CodexSession({ id: "s" });
  s.mergePage([{ id: "b", status: "inProgress", items: [] }], 0);
  const cut = s.revision;
  s.updateItem("b", { id: "msg", type: "agentMessage", text: "new" });
  s.updateTurn({ id: "b", status: "completed", items: [] }, true);
  s.mergePage(
    [
      {
        id: "b",
        status: "inProgress",
        items: [{ id: "msg", type: "agentMessage", text: "old" }],
      },
    ],
    cut,
  );
  s.mergePage(
    [
      {
        id: "a",
        status: "completed",
        items: [{ id: "old", type: "agentMessage", text: "older" }],
      },
    ],
    s.revision,
    true,
  );
  assert.deepEqual(s.order, ["a", "b"]);
  assert.equal(s.activeTurn, undefined);
  assert.deepEqual(
    projectSession(s.events()).messages.map((m) => m.text),
    ["older", "new"],
  );
});
test("initialize, subscribe all loaded sessions, prompt, steer and cancel use matching IDs", async (t) => {
  const { host, client, frames } = await setup(t);
  assert.equal(host.calls[0].method, "initialize");
  assert(
    host.calls.some(
      (c) => c.method === "thread/resume" && c.params.excludeTurns === true,
    ),
  );
  const content = [{ type: "text", text: "hello" }];
  await client.rpc("session.prompt", { sessionId: "thread-1", content });
  await client.rpc("session.prompt", { sessionId: "thread-1", content });
  const steer = host.calls.find((c) => c.method === "turn/steer");
  assert.equal(
    steer.params.expectedTurnId,
    host.sessions.get("thread-1").turns[0].id,
  );
  await client.rpc("session.cancel", { sessionId: "thread-1" });
  await until(() => frames.some((f) => f.payload.event?.type === "turn/end"));
  assert.equal(
    frames.find((f) => f.payload.event?.type === "turn/end").payload.event.data
      .reason.kind,
    "interrupted",
  );
  assert(host.calls.some((c) => c.method === "thread/list"));
});
test("blank, not-yet-materialized Codex threads can send their first message", async (t) => {
  const { host, client } = await setup(t);
  host.handler = (f, s) => {
    if (
      f.method === "thread/turns/list" &&
      !host.sessions.get(f.params.threadId).turns.length
    ) {
      s.send(
        JSON.stringify({
          id: f.id,
          error: { code: -32600, message: "thread is not materialized yet" },
        }),
      );
      return true;
    }
  };
  await client.rpc("session.prompt", {
    sessionId: "thread-1",
    content: [{ type: "text", text: "hello" }],
  });
  assert(host.calls.some((c) => c.method === "turn/start"));
});
test("approvals preserve numeric/string IDs, session/rule decisions and resolved requests", async (t) => {
  const { host, client, frames } = await setup(t);
  const params = {
    threadId: "thread-1",
    turnId: "t",
    itemId: "tool",
    command: "pwd",
    availableDecisions: [
      "accept",
      "decline",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } },
    ],
  };
  host.notify("item/commandExecution/requestApproval", params, 7);
  host.notify("item/commandExecution/requestApproval", params, "7");
  await until(() => client.pending.size === 2);
  await assert.rejects(
    client.respond("1:number:7", { sessionId: "wrong", outcome: "choice-0" }),
  );
  await client.respond("1:number:7", {
    sessionId: "thread-1",
    outcome: "choice-2",
  });
  await until(() => host.responses.length === 1);
  assert.equal(host.responses[0].id, 7);
  assert.deepEqual(host.responses[0].result, {
    decision: {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] },
    },
  });
  host.notify("serverRequest/resolved", {
    threadId: "thread-1",
    requestId: "7",
  });
  await until(() => client.pending.size === 0);
  await assert.rejects(
    client.respond("1:string:7", {
      sessionId: "thread-1",
      outcome: "choice-0",
    }),
  );
  assert(frames.some((f) => f.payload.type === "approval/resolved"));
});
test("questions map selected and free-text answers and unsupported prompts stay manual", async (t) => {
  const { host, client, frames } = await setup(t);
  host.notify(
    "item/tool/requestUserInput",
    {
      threadId: "thread-1",
      turnId: "t",
      questions: [{ id: "q", question: "which?" }],
    },
    "q1",
  );
  await until(() => client.pending.size === 1);
  await client.respond("1:string:q1", {
    sessionId: "thread-1",
    answer: { answers: [{ id: "q", selected: ["a"], custom: "extra" }] },
  });
  await until(() => host.responses.length === 1);
  assert.deepEqual(host.responses[0].result, {
    answers: { q: { answers: ["a", "extra"] } },
  });
  host.notify(
    "mcpServer/elicitation/request",
    { threadId: "thread-1", mode: "url", message: "login" },
    8,
  );
  await until(() => client.pending.size === 1);
  assert.deepEqual(frames.at(-1).payload.choices, []);
  assert.equal(host.responses.length, 1);
});
test("reconnect resubscribes and does not replay writes or historical completion sounds", async (t) => {
  const { host, client, frames } = await setup(t, { reconnectDelay: 10 });
  host.sessions.get("thread-1").turns = [
    { id: "old", status: "completed", items: [] },
  ];
  await client.rpc("session.history", { sessionId: "thread-1" });
  assert(!frames.some((f) => f.payload.type === "session/event"));
  host.disconnect();
  await until(
    () =>
      host.calls.filter((c) => c.method === "initialize").length === 2 &&
      client.streams.size === 2,
  );
  await client.rpc("session.list");
  assert.equal(
    host.calls.filter((c) => c.method === "thread/resume").length,
    2,
  );
  assert(!host.calls.some((c) => c.method === "turn/start"));
});
test("timed-out mutation is rejected without an automatic retry", async (t) => {
  const { host, client } = await setup(t, {
    transportFactory: (url) => new CodexTransport(url, { timeout: 80 }),
  });
  host.handler = (f) => f.method === "turn/start";
  await assert.rejects(
    client.rpc("session.prompt", {
      sessionId: "thread-1",
      content: [{ type: "text", text: "x" }],
    }),
    /超时/,
  );
  assert.equal(host.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("a stale session read cannot undo a live running status or remove a newly created thread", async (t) => {
  const { host, client } = await setup(t);
  let held;
  host.handler = (f, s) => {
    if (f.method === "thread/read" && !held) {
      const thread = structuredClone(host.sessions.get("thread-1"));
      held = () => s.send(JSON.stringify({ id: f.id, result: { thread } }));
      return true;
    }
  };
  const listing = client.rpc("session.list");
  await until(() => held);
  host.start("thread-1");
  const thread = host.add("new");
  host.notify("thread/started", { thread });
  await until(() => client.sessions.has("new"));
  held();
  await listing;
  assert.equal(client.sessions.get("thread-1").thread.status.type, "active");
  assert(client.sessions.has("new"));
});

for (const method of ["turn/started", "turn/completed"]) {
  test(`duplicate ${method} during a list cannot change runtime or clear a newer stream`, async (t) => {
    const { host, client, frames } = await setup(t);
    const id = "thread-1",
      row = client.sessions.get(id);
    const first = host.start(id),
      started = structuredClone(first);
    await until(() => row.thread.status.type === "active");
    host.finish(id, first);
    await until(() => row.thread.status.type === "idle");
    let current;
    if (method === "turn/completed") {
      current = host.start(id);
      host.notify("item/agentMessage/delta", {
        threadId: id,
        turnId: current.id,
        itemId: "reply-2",
        delta: "仍在回复",
      });
      await until(() => client.live.get(id)?.text === "仍在回复");
    }
    const running = !!current;
    const version = row.metadataVersion,
      live = client.live.get(id);
    const histories = frames.filter(
      (f) => f.payload.type === "session/history",
    ).length;
    const events = frames.filter(
      (f) => f.payload.type === "session/event",
    ).length;
    let release, listing, result;
    host.handler = (frame, socket) => {
      if (frame.method !== "thread/read" || frame.params.threadId !== id)
        return;
      const thread = structuredClone(host.sessions.get(id));
      release = () =>
        socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
      return true;
    };
    try {
      listing = client.rpc("session.list");
      await until(() => release);
      host.notify(method, {
        threadId: id,
        turn: method === "turn/started" ? started : first,
      });
      // A later notification on the same socket is a delivery barrier and
      // deliberately does not change runtime metadata or stream state.
      host.notify("thread/tokenUsage/updated", {
        threadId: id,
        tokenUsage: {
          total: { inputTokens: 123, cachedInputTokens: 0, outputTokens: 11 },
        },
      });
      await until(() => row.values.tokenUsage?.outputTokens === 11);
      assert.equal(row.thread.status.type, running ? "active" : "idle");
      assert.equal(row.turns.get(first.id).status, "completed");
      assert.equal(row.metadataVersion, version);
      assert.equal(client.live.get(id), live);
      assert.equal(
        frames.filter((f) => f.payload.type === "session/history").length,
        histories,
      );
      assert.equal(
        frames.filter((f) => f.payload.type === "session/event").length,
        events,
      );
    } finally {
      host.handler = null;
      release?.();
      result = await listing;
    }
    assert.equal(result.items.find((r) => r.sessionId === id).running, running);
  });
}

test("legacy history fallback is read-only and blank foreign drafts do not block other sessions", async (t) => {
  const { host, client } = await setup(t);
  host.add("draft");
  host.handler = (f, s) => {
    if (f.method === "thread/resume" && f.params.threadId === "draft") {
      s.send(
        JSON.stringify({
          id: f.id,
          error: {
            code: -32600,
            message: "no rollout found for thread id draft",
          },
        }),
      );
      return true;
    }
    if (f.method === "thread/turns/list") {
      s.send(
        JSON.stringify({
          id: f.id,
          error: { code: -32601, message: "list_turns is not supported yet" },
        }),
      );
      return true;
    }
    if (f.method === "thread/read" && f.params.includeTurns) {
      s.send(
        JSON.stringify({
          id: f.id,
          result: { thread: host.sessions.get(f.params.threadId) },
        }),
      );
      return true;
    }
  };
  assert.deepEqual(
    (await client.rpc("session.list")).items.map((i) => i.sessionId),
    ["thread-1"],
  );
  host.sessions.get("thread-1").turns = [
    {
      id: "legacy",
      status: "completed",
      items: [{ id: "msg", type: "agentMessage", text: "legacy history" }],
    },
  ];
  const result = await client.rpc("session.history", { sessionId: "thread-1" });
  assert.equal(
    projectSession(result.events.map((e) => e.event)).messages[0].text,
    "legacy history",
  );
  assert(!host.calls.some((c) => c.method === "turn/start"));
});
test("streamed item is not duplicated by a history refresh, and completion restores the full message", async (t) => {
  const { host, client } = await setup(t);
  const turn = host.start();
  host.item("thread-1", turn, {
    id: "stream",
    type: "agentMessage",
    text: "partial",
  });
  host.notify("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: turn.id,
    itemId: "stream",
    delta: "partial",
  });
  await until(() => client.live.has("thread-1"));
  let history = await client.rpc("session.history", { sessionId: "thread-1" });
  assert.equal(
    projectSession(history.events.map((e) => e.event)).messages.length,
    0,
  );
  host.item(
    "thread-1",
    turn,
    { id: "stream", type: "agentMessage", text: "partial complete" },
    true,
  );
  await until(() => !client.live.has("thread-1"));
  history = await client.rpc("session.history", { sessionId: "thread-1" });
  assert.deepEqual(
    projectSession(history.events.map((e) => e.event)).messages.map(
      (m) => m.text,
    ),
    ["partial complete"],
  );
});

test("interruption retains partial streamed text and stale approvals cannot cross reconnects", async (t) => {
  const { host, client } = await setup(t, { reconnectDelay: 10 });
  const turn = host.start();
  host.item("thread-1", turn, {
    id: "partial",
    type: "agentMessage",
    text: "prefix ",
  });
  host.notify("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: turn.id,
    itemId: "partial",
    delta: "suffix",
  });
  await until(() => client.live.get("thread-1")?.text === "prefix suffix");
  host.finish("thread-1", turn, "interrupted");
  await until(() => !client.live.has("thread-1"));
  assert.deepEqual(
    projectSession(client.sessions.get("thread-1").events()).messages.map(
      (m) => m.text,
    ),
    ["prefix suffix"],
  );
  const params = {
    threadId: "thread-1",
    turnId: "new-turn",
    itemId: "cmd",
    availableDecisions: ["accept"],
  };
  host.notify("item/commandExecution/requestApproval", params, 1);
  await until(() => client.pending.size === 1);
  const oldKey = [...client.pending.keys()][0];
  host.disconnect();
  await until(() => client.generation === 2 && client.streams.size === 2);
  await client.rpc("session.list");
  host.notify("item/commandExecution/requestApproval", params, 1);
  await until(() => client.pending.size === 1);
  assert.notEqual([...client.pending.keys()][0], oldKey);
  await assert.rejects(
    client.respond(oldKey, { sessionId: "thread-1", outcome: "choice-0" }),
  );
  assert.equal(host.responses.length, 0);
});

test("stored external threads expose history without resuming or allowing mutations", async (t) => {
  const { host, client, frames } = await setup(t);
  const external = host.add("desktop");
  external.status = { type: "notLoaded" };
  external.turns = [
    {
      id: "outside-turn",
      status: "inProgress",
      items: [{ id: "message", type: "agentMessage", text: "保存中的内容" }],
    },
  ];
  const row = (await client.rpc("session.list")).items.find(
    (row) => row.sessionId === "desktop",
  );
  assert.equal(row.readOnly, true);
  assert.equal(
    row.running,
    false,
    "a persisted unfinished turn is not a live runtime status",
  );
  let history = await client.rpc("session.history", { sessionId: "desktop" });
  assert.equal(
    projectSession(history.events.map((e) => e.event)).messages[0].text,
    "保存中的内容",
  );
  external.turns[0].items[0].text = "保存后的新内容";
  history = await client.rpc("session.history", { sessionId: "desktop" });
  assert.equal(
    projectSession(history.events.map((e) => e.event)).messages[0].text,
    "保存后的新内容",
  );
  for (const method of ["session.prompt", "session.cancel"]) {
    await assert.rejects(
      client.rpc(method, {
        sessionId: "desktop",
        content: [{ type: "text", text: "hello" }],
      }),
      /仅支持查看/,
    );
  }
  assert(
    !host.calls.some(
      (c) =>
        c.params?.threadId === "desktop" &&
        ["thread/resume", "turn/start", "turn/interrupt"].includes(c.method),
    ),
  );
  assert(
    !frames.some((f) => f.payload.type === "session/event"),
    "history refresh must not emit sounds/activity",
  );
});

test("stored list follows all pages and includes App Server sources", async (t) => {
  const { host, client } = await setup(t);
  for (const id of ["desktop", "old"])
    host.add(id).status = { type: "notLoaded" };
  host.handler = (f, socket) => {
    if (f.method !== "thread/list") return;
    assert(f.params.sourceKinds.includes("appServer"));
    const id = f.params.cursor ? "old" : "desktop";
    socket.send(
      JSON.stringify({
        id: f.id,
        result: {
          data: [host.sessions.get(id)],
          nextCursor: f.params.cursor ? null : "page-2",
        },
      }),
    );
    return true;
  };
  const rows = (await client.rpc("session.list")).items;
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), [
    "desktop",
    "old",
    "thread-1",
  ]);
  assert.equal(rows.filter((r) => r.readOnly).length, 2);
  assert(
    !host.calls.some(
      (c) => c.method === "thread/resume" && c.params.threadId !== "thread-1",
    ),
  );
});

test("unloaded sessions become read-only, and joining the shared runtime restores operations", async (t) => {
  const { host, client } = await setup(t);
  host.sessions.get("thread-1").status = { type: "notLoaded" };
  assert.equal((await client.rpc("session.list")).items[0].readOnly, true);
  await assert.rejects(
    client.rpc("session.cancel", { sessionId: "thread-1" }),
    /仅支持查看/,
  );
  host.sessions.get("thread-1").status = { type: "idle" };
  assert.equal((await client.rpc("session.list")).items[0].readOnly, false);
  await client.rpc("session.prompt", {
    sessionId: "thread-1",
    content: [{ type: "text", text: "hello" }],
  });
  assert.equal(host.calls.filter((c) => c.method === "turn/start").length, 1);
});
