import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  SessionClients,
  sessionKey,
  sessionSource,
} from "../shared/session-clients.mjs";
import { createFixture } from "./fixture.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";
import { ProgressTracker } from "../shared/progress.mjs";
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("timeout");
}
async function setup(t, fixtureOptions) {
  const dsh = await createFixture(fixtureOptions),
    codex = await createCodexHost(),
    client = new SessionClients();
  dsh.sessions.set("same", {
    sessionId: "same",
    title: "DSH 同名",
    cwd: "/tmp",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  codex.add("same");
  const frames = [];
  client.on("frame", (frame) => frames.push(frame));
  t.after(async () => {
    client.close();
    await Promise.all([dsh.close(), codex.close()]);
  });
  await Promise.all([
    client.connect("dsh", dsh.endpoint),
    client.connect("codex", codex.endpoint),
  ]);
  await until(() =>
    Object.values(client.connections()).every(
      (row) => row.status === "connected",
    ),
  );
  await client.rpc("session.list");
  return { dsh, codex, client, frames };
}
for (const provider of ["dsh", "codex"]) {
  test(`${provider} recovers current turn identity on reconnect without replaying task events`, async (t) => {
    const { dsh, codex, client, frames } = await setup(t);
    const id = sessionKey(provider, "same");
    let serial = 0;
    const start = () => {
      if (provider === "codex") return codex.start("same");
      dsh.sessions.get("same").running = true;
      const turn = { id: ++serial };
      dsh.event("same", "turn/start", { turn: turn.id });
      return turn;
    };
    const finish = (turn) => {
      if (provider === "codex") return codex.finish("same", turn);
      dsh.sessions.get("same").running = false;
      dsh.event("same", "turn/end", { turn: turn.id, reason: "completed" });
    };
    const read = async () =>
      (await client.rpc("session.list", { provider })).items.find(
        (row) => row.sessionId === id,
      );
    const first = start();
    await until(() =>
      frames.some(
        (frame) =>
          frame.payload.lastTurn?.key === JSON.stringify(first.id) &&
          frame.payload.sessionId === id,
      ),
    );
    const reconnect = async (offline) => {
      const epoch = client.connections()[provider].epoch;
      if (provider === "dsh") dsh.dropStreams();
      else codex.disconnect();
      await until(() => client.connections()[provider].epoch > epoch);
      offline?.();
      const taskEvents = frames.filter(
        (frame) => frame.payload.type === "session/event",
      ).length;
      await until(() => client.connections()[provider].status === "connected");
      const row = await read();
      assert.equal(
        frames.filter((frame) => frame.payload.type === "session/event").length,
        taskEvents,
      );
      return row;
    };
    let row = await reconnect();
    assert.deepEqual(row.lastTurn, {
      key: JSON.stringify(first.id),
      status: "thinking",
    });
    assert.equal(row.running, true);
    let second;
    row = await reconnect(() => {
      finish(first);
      second = start();
    });
    assert.deepEqual(row.lastTurn, {
      key: JSON.stringify(second.id),
      status: "thinking",
    });
    assert.equal(row.running, true);
    let third;
    row = await reconnect(() => {
      finish(second);
      third = start();
      finish(third);
    });
    assert.deepEqual(row.lastTurn, {
      key: JSON.stringify(third.id),
      status: "done",
    });
    assert.equal(row.running, false);
  });
}

test("a live turn wins over an in-flight history seed and unknown history is retried", async (t) => {
  let hold, release;
  const { dsh, client, frames } = await setup(t, {
    beforeRpcReply: ({ method }) => {
      if (method === "session.history" && hold)
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  t.after(() => release?.());
  const raw = dsh.sessions.get("same");
  raw.running = true;
  // Empty history is unknown, so the next refresh must retry it.
  let rows = (await client.rpc("session.list", { provider: "dsh" })).items;
  assert.equal(
    rows.find((row) => row.sessionId === "same").lastTurn,
    undefined,
  );
  raw.events.push({ seq: 0, type: "turn/start", data: { turn: 1 } });
  hold = true;
  const listing = client.rpc("session.list", { provider: "dsh" });
  await until(() => release);
  dsh.event("same", "turn/end", { turn: 1, reason: "completed" });
  dsh.event("same", "turn/start", { turn: 2 });
  await until(() => frames.at(-1)?.payload.lastTurn?.key === "2");
  hold = false;
  release();
  rows = (await listing).items;
  const current = rows.find((row) => row.sessionId === "same");
  assert.equal(current.running, true);
  assert.deepEqual(current.lastTurn, { key: "2", status: "thinking" });
  const reads = dsh.calls.filter(
    (call) => call.method === "session.history",
  ).length;
  await client.rpc("session.list", { provider: "dsh" });
  assert.equal(
    dsh.calls.filter((call) => call.method === "session.history").length,
    reads,
    "live identity avoids repeated history reads",
  );
});

test("Codex reattach verifies the current turn instead of reusing the prior subscription's cache", async (t) => {
  const { codex, client, frames } = await setup(t);
  const read = async () =>
    (await client.rpc("session.list", { provider: "codex" })).items.find(
      (row) => row.sessionId === "codex:same",
    );
  const first = codex.start("same");
  codex.finish("same", first);
  await until(() =>
    frames.some((frame) => frame.payload.lastTurn?.status === "done"),
  );
  const loaded = await read();
  codex.sessions.get("same").status = { type: "notLoaded" };
  const unloaded = await read();
  assert.equal(unloaded.readOnly, true);
  assert(unloaded.followRevision > loaded.followRevision);
  const second = {
    id: "started-before-resubscribe",
    status: "inProgress",
    items: [],
  };
  codex.sessions.get("same").turns.push(second);
  codex.sessions.get("same").status = { type: "active" };
  const followed = await read();
  assert(followed.followRevision > unloaded.followRevision);
  assert.deepEqual(followed.lastTurn, {
    key: JSON.stringify(second.id),
    status: "thinking",
  });
  codex.finish("same", second);
  await until(() => followed.lastTurn?.status === "done");
  assert.equal(followed.lastTurn.key, JSON.stringify(second.id));
});

test("Codex reconnect restores observed read-only turns without hydrating unrelated historical sessions", async (t) => {
  const { codex, client, frames } = await setup(t);
  const first = codex.start("same");
  await until(() =>
    frames.some(
      (frame) => frame.payload.lastTurn?.key === JSON.stringify(first.id),
    ),
  );
  const epoch = client.connections().codex.epoch;
  codex.disconnect();
  await until(() => client.connections().codex.epoch > epoch);
  codex.finish("same", first);
  const second = codex.start("same");
  codex.finish("same", second);
  codex.sessions.get("same").status = { type: "notLoaded" };
  const old = codex.add("unobserved-history");
  old.status = { type: "notLoaded" };
  old.turns.push({ id: "old-turn", status: "completed", items: [] });
  const eventCount = frames.filter(
    (frame) => frame.payload.type === "session/event",
  ).length;
  await until(() => client.connections().codex.status === "connected");
  const rows = (await client.rpc("session.list", { provider: "codex" })).items;
  const restored = rows.find((row) => row.sessionId === "codex:same");
  assert.equal(restored.readOnly, true);
  assert.deepEqual(restored.lastTurn, {
    key: JSON.stringify(second.id),
    status: "done",
  });
  assert.equal(
    rows.find((row) => row.sessionId === "codex:unobserved-history").lastTurn,
    undefined,
  );
  assert.equal(
    codex.calls.some(
      (call) =>
        call.method === "thread/turns/list" && call.params.threadId === old.id,
    ),
    false,
  );
  assert.equal(
    frames.filter((frame) => frame.payload.type === "session/event").length,
    eventCount,
  );
});

test("a verified full rollback allows later legacy work without retaining a removed anchor", async (t) => {
  const { codex, client, frames } = await setup(t);
  const read = async () =>
    (await client.rpc("session.list", { provider: "codex" })).items.find(
      (row) => row.sessionId === "codex:same",
    );
  const first = codex.start("same");
  codex.finish("same", first);
  await until(() =>
    frames.some((frame) => frame.payload.lastTurn?.status === "done"),
  );
  await read();
  const reconnect = async (change) => {
    const epoch = client.connections().codex.epoch;
    codex.disconnect();
    await until(() => client.connections().codex.epoch > epoch);
    change();
    await until(() => client.connections().codex.status === "connected");
    return read();
  };
  const raw = codex.sessions.get("same");
  const empty = await reconnect(() => {
    raw.turns = [];
    raw.status = { type: "notLoaded" };
  });
  assert.equal(empty.lastTurn, undefined);
  const fresh = await reconnect(() =>
    raw.turns.push({ id: "legacy-new", status: "completed", items: [] }),
  );
  assert.deepEqual(fresh.lastTurn, {
    key: JSON.stringify("legacy-new"),
    status: "done",
  });
});

for (const hidden of [false, true]) {
  test(
    `a reverted history seed preserves ${hidden ? "dismissed" : "visible"} completion and retries without losing its anchor`,
    { timeout: 5000 },
    async (t) => {
      const { codex, client, frames } = await setup(t);
      const raw = codex.sessions.get("same");
      const id = "codex:same";
      const read = async () =>
        (await client.rpc("session.list", { provider: "codex" })).items.find(
          (row) => row.sessionId === id,
        );
      raw.turns = Array.from({ length: 40 }, (_, i) => ({
        id: `old-${i + 1}`,
        startedAt: i + 1,
        status: "completed",
        items: [],
      }));
      let hold = false;
      const waiting = Promise.withResolvers();
      codex.handler = (frame, socket) => {
        if (frame.method !== "thread/turns/list") return false;
        const ordered = [...raw.turns].reverse();
        const offset = frame.params.cursor
          ? ordered.findIndex((turn) => turn.id === frame.params.cursor) + 1
          : 0;
        const data = ordered.slice(offset, offset + frame.params.limit);
        const response = JSON.stringify({
          id: frame.id,
          result: {
            data,
            nextCursor:
              offset + data.length < ordered.length ? data.at(-1).id : null,
          },
        });
        const reply = () => socket.send(response);
        if (hold) waiting.resolve(reply);
        else reply();
        return true;
      };
      const first = codex.start("same");
      first.startedAt = 50;
      codex.finish("same", first);
      await until(() =>
        frames.some((frame) => frame.payload.lastTurn?.status === "done"),
      );
      const tracker = new ProgressTracker();
      const sync = (row, now) =>
        tracker.sync(
          {
            connection: "connected",
            sessions: [row],
            pending: [],
            activity: {},
          },
          now,
        )[id];
      tracker.start(id, JSON.stringify(first.id));
      sync(await read(), 100);
      if (hidden) tracker.dismiss(id);
      const before = { ...tracker.entries.get(id) };

      // Resubscribe without seeding the unloaded state first. The new
      // subscription must verify its history even though no new task is active.
      let count = frames.length;
      codex.notify("thread/status/changed", {
        threadId: raw.id,
        status: { type: "notLoaded" },
      });
      await until(() => frames.length > count);
      hold = true;
      const pending = read();
      pending.catch(() => {});
      const release = await waiting.promise;
      raw.turns = raw.turns.slice(0, 5);
      count = frames.length;
      codex.notify("thread/reverted", { threadId: raw.id });
      await until(() =>
        frames.slice(count).some((frame) => frame.payload.reset),
      );
      hold = false;
      release();
      const invalid = await pending;
      assert.equal(invalid.lastTurn, undefined);
      assert.deepEqual(sync(invalid, 200), before);

      const retried = await read();
      assert.equal(retried.lastTurn.key, JSON.stringify("old-5"));
      assert.equal(retried.lastTurn.historical, true);
      assert.deepEqual(sync(retried, 300), before);

      // A real task discovered on the next unload still reopens the bubble.
      raw.turns.push({
        id: "new-after-revert",
        startedAt: 60,
        status: "completed",
        items: [],
      });
      raw.status = { type: "notLoaded" };
      const after = sync(await read(), 400);
      assert.equal(after.turn, JSON.stringify("new-after-revert"));
      assert.equal(after.hidden, false);
      assert.equal(after.status, "done");
      assert(after.completedAt > before.completedAt);
    },
  );
}

test("failed Codex reattach hydration cannot publish an old turn and later live completion wins over held history", async (t) => {
  const { codex, client, frames } = await setup(t);
  const read = async () =>
    (await client.rpc("session.list", { provider: "codex" })).items.find(
      (row) => row.sessionId === "codex:same",
    );
  const first = codex.start("same");
  codex.finish("same", first);
  await until(() =>
    frames.some((frame) => frame.payload.lastTurn?.status === "done"),
  );
  await read();
  codex.sessions.get("same").status = { type: "notLoaded" };
  await read();
  const second = {
    id: "reattach-after-failure",
    status: "inProgress",
    items: [],
  };
  codex.sessions.get("same").turns.push(second);
  codex.sessions.get("same").status = { type: "active" };
  codex.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32000, message: "history unavailable" },
      }),
    );
    return true;
  };
  const unknown = await read();
  assert.equal(unknown.running, true);
  assert.equal(
    unknown.lastTurn,
    undefined,
    "old subscription identity must not identify this task",
  );
  let release;
  codex.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return;
    const data = structuredClone(
      [...codex.sessions.get("same").turns].reverse(),
    );
    release = () =>
      socket.send(
        JSON.stringify({ id: frame.id, result: { data, nextCursor: null } }),
      );
    return true;
  };
  const listing = read();
  await until(() => release);
  codex.finish("same", second);
  await until(() => unknown.lastTurn?.key === JSON.stringify(second.id));
  release();
  codex.handler = null;
  const finished = await listing;
  assert.equal(finished.running, false);
  assert.deepEqual(finished.lastTurn, {
    key: JSON.stringify(second.id),
    status: "done",
  });
});

test("session keys are reversible and cannot collide across platforms or reserved prefixes", () => {
  const keys = new Set();
  for (const provider of ["dsh", "codex"])
    for (const id of ["same", "codex:same", "~same", "~~same", "codex:~same"]) {
      const key = sessionKey(provider, id);
      assert(!keys.has(key));
      keys.add(key);
      assert.deepEqual(sessionSource(key), { provider, id });
    }
});
test("both platforms stay connected and reads, prompts and creation route to their own platform", async (t) => {
  const { dsh, codex, client } = await setup(t);
  const rows = (await client.rpc("session.list")).items;
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.provider]),
    [
      ["same", "dsh"],
      ["codex:same", "codex"],
    ],
  );
  await client.rpc("session.prompt", {
    sessionId: "codex:same",
    content: [{ type: "text", text: "Codex message" }],
  });
  assert(codex.calls.some((c) => c.method === "turn/start"));
  assert(!dsh.calls.some((c) => c.method === "session.prompt"));
  await client.rpc("session.prompt", {
    sessionId: "same",
    content: [{ type: "text", text: "DSH message" }],
  });
  assert(
    dsh.calls.some(
      (c) => c.method === "session.prompt" && c.payload.sessionId === "same",
    ),
  );
  const result = await client.rpc("session.create", {
    provider: "codex",
    cwd: "/tmp",
    sessionId: "ignored",
  });
  assert.equal(sessionSource(result.sessionId).provider, "codex");
  await client.rpc("session.create", {
    provider: "dsh",
    cwd: "/tmp",
    sessionId: "new-dsh",
  });
  assert(dsh.sessions.has("new-dsh"));
});
test("approval replies are bound to their provider and cannot be submitted from a colliding session", async (t) => {
  const { codex, client, frames } = await setup(t);
  codex.notify(
    "item/commandExecution/requestApproval",
    {
      threadId: "same",
      turnId: "t",
      itemId: "tool",
      command: "pwd",
      availableDecisions: ["accept"],
    },
    7,
  );
  await until(() =>
    frames.some((f) => f.payload.type === "approval/requested"),
  );
  const approval = frames.find((f) => f.payload.type === "approval/requested");
  assert.equal(approval.payload.sessionId, "codex:same");
  assert.equal(approval.payload.provider, "codex");
  await assert.rejects(
    client.respond(approval.rpcId, { sessionId: "same", outcome: "choice-0" }),
  );
  await client.respond(approval.rpcId, {
    sessionId: "codex:same",
    outcome: "choice-0",
  });
  await until(() => codex.responses.length === 1);
  assert.deepEqual(codex.responses[0], {
    id: 7,
    result: { decision: "accept" },
  });
});
test("disconnecting or replacing one platform retains the other platform and rejects old approvals", async (t) => {
  const { codex, client, frames } = await setup(t);
  codex.notify(
    "item/commandExecution/requestApproval",
    {
      threadId: "same",
      turnId: "t",
      itemId: "tool",
      availableDecisions: ["accept"],
    },
    1,
  );
  await until(() =>
    frames.some((f) => f.payload.type === "approval/requested"),
  );
  const rpcId = frames.find(
    (f) => f.payload.type === "approval/requested",
  ).rpcId;
  client.disconnect("codex");
  assert.equal(client.connections().dsh.status, "connected");
  assert.equal(client.connections().codex.status, "offline");
  assert.deepEqual(
    (await client.rpc("session.list")).items.map((r) => r.sessionId),
    ["same"],
  );
  await client.connect("codex", codex.endpoint);
  await client.rpc("session.list");
  await assert.rejects(
    client.respond(rpcId, { sessionId: "codex:same", outcome: "choice-0" }),
  );
  client.disconnect("dsh");
  assert.equal(client.connections().codex.status, "connected");
});
test("usage and projection snapshots keep provider namespaces even with identical raw IDs", async (t) => {
  const { codex, client, frames } = await setup(t);
  codex.notify("thread/tokenUsage/updated", {
    threadId: "same",
    turnId: "t",
    tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
      last: { totalTokens: 110 },
      modelContextWindow: 1000,
    },
  });
  await until(() =>
    frames.some((f) => f.payload.type === "session/projection"),
  );
  assert(
    frames
      .filter((f) => f.payload.type === "session/projection")
      .every((f) => f.payload.sessionId === "codex:same"),
  );
  assert.equal(client.connections().dsh.status, "connected");
});

test("a slow Codex list does not block creating and refreshing DSH sessions", async (t) => {
  const { codex, client } = await setup(t);
  let held,
    finished = false;
  codex.handler = (frame, socket) => {
    if (frame.method === "thread/loaded/list") {
      held = () =>
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: { data: [...codex.sessions.keys()] },
          }),
        );
      return true;
    }
  };
  const slow = client.rpc("session.list", { provider: "codex" }).then(() => {
    finished = true;
  });
  await until(() => held);
  await client.rpc("session.create", {
    provider: "dsh",
    sessionId: "independent",
    cwd: "/tmp",
  });
  const result = await client.rpc("session.list", { provider: "dsh" });
  assert(result.items.some((row) => row.sessionId === "independent"));
  assert.equal(finished, false);
  held();
  await slow;
});

test("reconnecting runtime placeholders remain unknown until that source refreshes", async (t) => {
  const { dsh, codex, client } = await setup(t);
  dsh.sessions.get("same").running = true;
  codex.start("same");
  await client.rpc("session.list");
  for (const provider of ["dsh", "codex"]) {
    const key = sessionKey(provider, "same"),
      other = provider === "dsh" ? "codex" : "dsh",
      epoch = client.connections()[provider].epoch;
    if (provider === "dsh") dsh.dropStreams();
    else codex.disconnect();
    await until(() => client.connections()[provider].epoch > epoch);
    await until(() => client.connections()[provider].status === "connected");
    let rows = (await client.rpc("session.list", { provider: other })).items;
    assert.equal(rows.find((row) => row.sessionId === key).runningKnown, false);
    assert.equal(rows.find((row) => row.sessionId === key).running, false);
    assert.equal(rows.find((row) => row.provider === other).runningKnown, true);
    rows = (await client.rpc("session.list", { provider })).items;
    assert.equal(rows.find((row) => row.sessionId === key).runningKnown, true);
    assert.equal(rows.find((row) => row.sessionId === key).running, true);
  }
});

test("duplicate and reordered events cannot mutate cached runtime or override a later event", async (t) => {
  const { dsh, client, frames } = await setup(t);
  const cached = (await client.rpc("session.list")).items.find(
    (row) => row.sessionId === "same",
  );
  const start = dsh.event("same", "turn/start", { turn: 1 });
  await until(() => cached.running === true);
  const end = dsh.event("same", "turn/end", { reason: "completed" });
  await until(() => cached.running === false);
  const replay = async (event) => {
    const count = frames.length;
    dsh.push("mux", { type: "session/event", sessionId: "same", event });
    await until(() => frames.length > count);
  };
  await replay(start);
  assert.equal(
    cached.running,
    false,
    "an old start cannot resurrect finished work",
  );
  dsh.event("same", "turn/start", { turn: 2 });
  await until(() => cached.running === true);
  await replay(end);
  assert.equal(cached.running, true, "an old end cannot finish the next turn");
  dsh.event("same", "turn/end", { turn: 2, reason: "completed" });
  await until(() => cached.running === false);
  const chunk = dsh.event("same", "assistant/chunk", {
    chunk: { type: "text-delta", text: "done" },
  });
  await until(() => frames.at(-1)?.payload.event?.type === "assistant/chunk");
  await replay({ ...start, seq: chunk.seq });
  assert.equal(
    cached.running,
    false,
    "ordering must include non-boundary events",
  );
  const rows = (await client.rpc("session.list", { provider: "codex" })).items;
  assert.equal(rows.find((row) => row.sessionId === "same").running, false);
});

test("DSH host status invalidates the snapshot without overwriting newer mux events", async (t) => {
  const { dsh, client, frames } = await setup(t);
  const cached = (await client.rpc("session.list")).items.find(
    (row) => row.sessionId === "same",
  );
  dsh.event("same", "turn/start", { turn: 1 });
  dsh.event("same", "turn/end", { turn: 1, reason: "completed" });
  dsh.sessions.get("same").running = true;
  const latest = dsh.event("same", "turn/start", { turn: 2 });
  await until(() => frames.at(-1)?.payload.event?.seq === latest.seq);
  // These statuses are ordered on the host socket, but lag the mux socket.
  for (const running of [false, true]) {
    const count = frames.length;
    dsh.push("host", {
      type: "host/session-status",
      sessionId: "same",
      running,
    });
    await until(() => frames.length > count);
    assert.equal(cached.running, true);
    assert.equal(frames.at(-1).payload.type, "host/session-invalidated");
    assert.equal(frames.at(-1).payload.running, undefined);
    const fresh = (await client.rpc("session.list", { provider: "dsh" })).items;
    assert.equal(fresh.find((row) => row.sessionId === "same").running, true);
  }
  const before = (await client.rpc("session.list")).items;
  const after = (await client.rpc("session.list", { provider: "dsh" })).items;
  assert(
    after.find((row) => row.sessionId === "same").metadataRevision >
      before.find((row) => row.sessionId === "same").metadataRevision,
  );
  assert.equal(
    after.find((row) => row.sessionId === "codex:same").metadataRevision,
    before.find((row) => row.sessionId === "codex:same").metadataRevision,
    "another platform's refresh cannot confirm cached read-only metadata",
  );
});

test("a delayed first list cannot overwrite newer live runtime or resurrect a removed session", async (t) => {
  let release;
  const dsh = await createFixture({
    beforeRpcReply: ({ method }) =>
      method === "session.list"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined,
  });
  const client = new SessionClients(),
    frames = [];
  client.on("frame", (frame) => frames.push(frame));
  t.after(async () => {
    release?.();
    client.close();
    await dsh.close();
  });
  await client.connect("dsh", dsh.endpoint);
  await until(() => client.connections().dsh.status === "connected");
  for (const [id, running] of [
    ["started", false],
    ["ended", true],
    ["removed", true],
  ])
    dsh.sessions.set(id, { sessionId: id, running, events: [] });
  const listing = client.rpc("session.list");
  await until(() => release);
  dsh.event("started", "turn/start", { turn: 1 });
  dsh.event("ended", "turn/end", { reason: "completed" });
  dsh.push("host", { type: "host/session-removed", sessionId: "removed" });
  await until(() =>
    ["started", "ended", "removed"].every((id) =>
      frames.some((frame) => frame.payload.sessionId === id),
    ),
  );
  release();
  const rows = (await listing).items;
  assert.equal(rows.find((row) => row.sessionId === "started").running, true);
  assert.equal(rows.find((row) => row.sessionId === "ended").running, false);
  assert.equal(
    rows.some((row) => row.sessionId === "removed"),
    false,
  );
});

for (const boundary of ["turn/start", "turn/end"])
  test(`removal survives delayed mux frames until a fresh list confirms reattachment; boundary = ${boundary}`, async (t) => {
    let release,
      hold = true;
    const dsh = await createFixture({
      beforeRpcReply: ({ method }) =>
        method === "session.list" && hold
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    const client = new SessionClients(),
      frames = [];
    client.on("frame", (frame) => frames.push(frame));
    t.after(async () => {
      release?.();
      client.close();
      await dsh.close();
    });
    for (const sessionId of ["removed", "alive"])
      dsh.sessions.set(sessionId, { sessionId, running: false, events: [] });
    await client.connect("dsh", dsh.endpoint);
    const listing = client.rpc("session.list");
    await until(() => release);
    dsh.push(
      "mux",
      { type: "approval/requested", sessionId: "removed", approvalId: "old" },
      "old-approval",
    );
    await until(() => client.pending.size === 1);
    dsh.sessions.delete("removed");
    dsh.push("host", { type: "host/session-removed", sessionId: "removed" });
    await until(() =>
      frames.some((frame) => frame.payload.type === "host/session-removed"),
    );
    const afterRemoval = frames.length;
    for (const payload of [
      {
        type: "session/event",
        event: {
          seq: 12,
          type: boundary,
          data: { turn: 1, reason: { kind: "completed" } },
        },
      },
      {
        type: "session/assistant-stream",
        frame: { type: "start", attemptId: "old", revision: 1 },
      },
      { type: "approval/requested", approvalId: "late" },
    ])
      dsh.push("mux", { ...payload, sessionId: "removed" });
    dsh.push("mux", {
      type: "session/projections",
      projections: { removed: { asOfSeq: 12, values: { title: "Deleted" } } },
    });
    // A later frame on the same socket proves all preceding frames arrived,
    // including those which should have been suppressed by the client.
    dsh.event("alive", "turn/end", { turn: 1, reason: { kind: "completed" } });
    await until(() =>
      frames.some((frame) => frame.payload.sessionId === "alive"),
    );
    release();
    assert.equal(
      (await listing).items.some((row) => row.sessionId === "removed"),
      false,
    );
    assert.equal(
      client.entries.get("dsh").runtime.get("removed")?.removed,
      true,
    );
    assert.equal(client.pending.size, 0);
    assert.ok(
      !frames
        .slice(afterRemoval)
        .some(
          (frame) =>
            frame.payload.sessionId === "removed" ||
            frame.payload.projections?.removed,
        ),
    );

    hold = false;
    dsh.sessions.set("removed", {
      sessionId: "removed",
      running: true,
      events: [{ seq: 0, type: "turn/start", data: { turn: 2 } }],
    });
    dsh.push("host", { type: "host/session-added", sessionId: "removed" });
    await until(() =>
      frames.some((frame) => frame.payload.type === "host/session-added"),
    );
    const restored = (await client.rpc("session.list")).items.find(
      (row) => row.sessionId === "removed",
    );
    assert.equal(restored?.running, true);
    assert.equal(restored?.lastTurn?.key, "2");
    assert.ok(!client.entries.get("dsh").runtime.get("removed")?.removed);
    dsh.event("removed", "turn/end", {
      turn: 2,
      reason: { kind: "completed" },
    });
    await until(() => restored.running === false);
    assert.equal(restored.lastTurn.status, "done");
  });

for (const oldList of [false, true])
  test(`reattachment admits new requests without reviving an older list; old list = ${oldList}`, async (t) => {
    let hold = false,
      release;
    const dsh = await createFixture({
      beforeRpcReply: ({ method }) =>
        method === "session.list" && hold
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    const client = new SessionClients(),
      frames = [];
    client.on("frame", (frame) => frames.push(frame));
    t.after(async () => {
      release?.();
      client.close();
      await dsh.close();
    });
    for (const sessionId of ["reattached", "sentinel"])
      dsh.sessions.set(sessionId, { sessionId, running: false, events: [] });
    await client.connect("dsh", dsh.endpoint);
    await client.rpc("session.list");
    hold = true;
    let listing;
    if (oldList) {
      listing = client.rpc("session.list");
      await until(() => release);
    }
    dsh.sessions.delete("reattached");
    dsh.push("host", { type: "host/session-removed", sessionId: "reattached" });
    await until(
      () => client.entries.get("dsh").runtime.get("reattached")?.removed,
    );
    dsh.sessions.set("reattached", {
      sessionId: "reattached",
      running: false,
      events: [],
    });
    dsh.push("host", { type: "host/session-added", sessionId: "reattached" });
    await until(() =>
      frames.some((frame) => frame.payload.type === "host/session-added"),
    );
    if (!oldList) {
      listing = client.rpc("session.list");
      await until(() => release);
    }
    dsh.sessions.get("reattached").running = true;
    dsh.event("reattached", "turn/start", { turn: 2 });
    const approval = {
      type: "approval/requested",
      sessionId: "reattached",
      approvalId: "new-approval",
    };
    const question = {
      type: "question/requested",
      sessionId: "reattached",
      questions: [],
    };
    dsh.pending.set("new-approval-rpc", approval);
    dsh.pending.set("new-question-rpc", question);
    dsh.push("host", approval, "new-approval-rpc");
    dsh.push("host", question, "new-question-rpc");
    // Requests can also resolve while the list is pending.
    dsh.push("host", { ...approval, approvalId: "settled" }, "settled-rpc");
    dsh.push("host", {
      type: "approval/resolved",
      sessionId: "reattached",
      approvalId: "settled",
    });
    dsh.push("mux", {
      type: "session/assistant-stream",
      sessionId: "reattached",
      frame: { type: "start", attemptId: "new", revision: 1 },
    });
    dsh.push("mux", {
      type: "session/projections",
      projections: {
        reattached: { asOfSeq: 0, values: { title: "Reattached" } },
      },
    });
    dsh.push("host", { type: "host/session-added", sessionId: "sentinel" });
    dsh.event("sentinel", "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await until(
      () =>
        frames.some(
          (f) =>
            f.payload.sessionId === "sentinel" &&
            f.payload.type === "host/session-added",
        ) &&
        frames.some(
          (f) =>
            f.payload.sessionId === "sentinel" &&
            f.payload.type === "session/event",
        ),
    );
    release();
    const first = (await listing).items.find(
      (row) => row.sessionId === "reattached",
    );
    assert.equal(
      !!first,
      !oldList,
      "a pre-removal list must still be rejected after reattachment",
    );
    if (first)
      assert.equal(
        first.running,
        true,
        "new live state takes precedence over the list snapshot",
      );
    hold = false;
    const restored = (await client.rpc("session.list")).items.find(
      (row) => row.sessionId === "reattached",
    );
    assert.equal(restored.running, true);
    assert.equal(restored.lastTurn.key, "2");
    assert.equal(
      client.pending.size,
      2,
      "new requests survive the reattachment window; resolved ones stay resolved",
    );
    assert.ok(
      frames.some(
        (frame) =>
          frame.payload.type === "session/assistant-stream" &&
          frame.payload.sessionId === "reattached",
      ),
    );
    assert.ok(frames.some((frame) => frame.payload.projections?.reattached));
    const requested = frames.filter(
      (frame) =>
        ["approval/requested", "question/requested"].includes(
          frame.payload.type,
        ) && frame.rpcId.includes("new-"),
    );
    assert.equal(requested.length, 2);
    for (const frame of requested)
      await client.respond(frame.rpcId, {
        sessionId: "reattached",
        outcome: "rejected",
        answers: [],
      });
    assert.equal(client.pending.size, 0);
    assert.equal(
      dsh.pending.size,
      0,
      "both reattached requests remain answerable through their original RPC IDs",
    );
  });
