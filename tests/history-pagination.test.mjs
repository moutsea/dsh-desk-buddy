import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { SessionClients, sessionKey } from "../shared/session-clients.mjs";
import { setHistoryEvents } from "../electron/history-state.mjs";
import { mergeEvents } from "../shared/projection.mjs";
import { mainActions } from "./helpers/main-actions.mjs";
import { createFixture } from "./fixture.mjs";

const events = (start, end) =>
  Array.from({ length: end - start }, (_, offset) => ({
    seq: start + offset,
    type: "user/message",
    data: { content: [{ type: "text", text: `Message ${start + offset}` }] },
  }));
const page = (start, end, hasMore = start > 0) => ({
  events: events(start, end).map((event) => ({ event })),
  hasMore,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function until(predicate) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Fixture timed out");
}
class Adapter extends EventEmitter {
  streams = new Set();
  events = events(0, 40);
  calls = [];
  read = (payload) => {
    const matching = this.events.filter(
      (event) =>
        payload.beforeSeq === undefined || event.seq < payload.beforeSeq,
    );
    return {
      events: matching.slice(-40).map((event) => ({ event })),
      hasMore: matching.length > 40,
    };
  };
  async connect() {
    for (const kind of ["mux", "host"]) {
      this.streams.add(kind);
      this.emit("stream", { kind, connected: true });
    }
    return { version: "fixture", cwd: "/tmp" };
  }
  async rpc(method, payload) {
    if (method === "session.list")
      return {
        items: [
          { sessionId: "saved", running: false, blank: false },
          { sessionId: "other", running: false, blank: false },
        ],
      };
    if (method !== "session.history")
      throw new Error(`Unexpected method ${method}`);
    this.calls.push(payload);
    if (payload.sessionId === "other") return page(900, 901, false);
    return this.read(payload);
  }
  close() {
    this.removeAllListeners();
  }
}
function mainState(client, id) {
  return {
    config: {
      provider: id.startsWith("codex:") ? "codex" : "dsh",
      selectedId: id,
    },
    selectedId: id,
    sessions: [],
    events: [],
    eventsRevision: 0,
    liveAssistant: {},
    activity: {},
    connections: client.connections(),
    hasMore: false,
    surface: { section: "chat" },
    pending: [],
    completions: [],
    taskSounds: [],
    connection: "connected",
    connectionEpoch: 1,
  };
}
async function setup(t, { provider = "dsh", initialCount = 40 } = {}) {
  const adapter = new Adapter();
  adapter.events = events(0, initialCount);
  const client = new SessionClients({ factory: () => adapter });
  t.after(() => client.close());
  await client.connect(provider, "fixture");
  const id = sessionKey(provider, "saved"),
    state = mainState(client, id);
  const actions = mainActions({ client, state, connectionLifecycle: true });
  await actions.invoke("refresh");
  return {
    adapter,
    client,
    id,
    state,
    ...actions,
    seqs: () => Array.from(state.events, (event) => event.seq),
    drop() {
      adapter.streams.delete("mux");
      adapter.emit("stream", { kind: "mux", connected: false });
    },
    async reopen() {
      adapter.streams.add("mux");
      adapter.emit("stream", { kind: "mux", connected: true });
      await flush();
    },
    async tick() {
      actions.poll();
      await flush();
    },
  };
}

for (const provider of ["dsh", "codex"])
  for (const olderFails of [false, true])
    test(`older reads cannot settle or overwrite a failed newest-history reload; provider = ${provider}, older fails = ${olderFails}`, async (t) => {
      const f = await setup(t, { provider, initialCount: 80 });
      const read = f.adapter.read;
      let failLatest = true;
      f.adapter.read = (payload) => {
        if (payload.beforeSeq === undefined && failLatest)
          throw new Error("Latest history unavailable");
        if (payload.beforeSeq !== undefined && olderFails)
          throw new Error("Older page unavailable");
        const result = read(payload);
        return provider === "codex" ? { ...result, replace: true } : result;
      };
      f.drop();
      f.adapter.events = events(0, 90);
      await f.reopen();
      assert.match(f.state.historyReload.error, /Latest history unavailable/);
      const older = f.invoke("older", { sessionId: f.id, requestId: "older" });
      if (olderFails) await assert.rejects(older, /Older page unavailable/);
      else await older;
      assert.match(
        f.state.historyReload?.error || "",
        /Latest history unavailable/,
        "paging must not acknowledge the latest-history gap or replace its error",
      );
      failLatest = false;
      f.adapter.read = (payload) => {
        const result = read(payload);
        return provider === "codex" ? { ...result, replace: true } : result;
      };
      await f.tick();
      assert.ok(f.seqs().includes(89));
      assert.equal(f.state.historyReload, null);
    });

for (const initialCount of [40, 80])
  test(`DSH fills every page between the retained window and the new head; initial messages = ${initialCount}`, async (t) => {
    const f = await setup(t, { initialCount });
    const oldStart = initialCount - 40;
    f.drop();
    f.adapter.events = events(0, 180);
    await f.reopen();
    assert.deepEqual(
      f.seqs(),
      Array.from({ length: 180 - oldStart }, (_, i) => oldStart + i),
    );
    assert.equal(
      f.state.hasMore,
      oldStart > 0,
      "gap filling must preserve the existing older-page cursor",
    );
    assert.equal(f.state.historyReload, null);
    const reads = f.adapter.calls.length;
    await f.tick();
    assert.equal(f.adapter.calls.length, reads);
  });

test("a failed middle page keeps the cached history intact and retries the complete gap", async (t) => {
  const f = await setup(t);
  const read = f.adapter.read;
  let fail = true;
  f.adapter.read = (payload) => {
    if (payload.beforeSeq === 100 && fail)
      throw new Error("Middle page unavailable");
    return read(payload);
  };
  f.drop();
  f.adapter.events = events(0, 180);
  const publishedBefore = f.published.length;
  await f.reopen();
  assert.match(f.state.historyReload?.error || "", /Middle page unavailable/);
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 40 }, (_, i) => i),
  );
  assert.ok(
    f.published
      .slice(publishedBefore)
      .every((state) => state.events.length === 40),
    "do not broadcast either side of an unfilled gap as complete history",
  );
  fail = false;
  await f.tick();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 180 }, (_, i) => i),
  );
  assert.equal(f.state.historyReload, null);
});

test("repeated reconnects retain the original gap boundary despite newer live events", async (t) => {
  const f = await setup(t);
  f.drop();
  setHistoryEvents(f.state, mergeEvents(f.state.events, events(139, 140)));
  f.drop();
  f.adapter.events = events(0, 180);
  await f.reopen();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 180 }, (_, i) => i),
  );
});

test("overlapping recent pages need no extra reads or older-cursor changes", async (t) => {
  const f = await setup(t, { initialCount: 80 });
  f.drop();
  f.adapter.events = events(0, 90);
  await f.reopen();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 50 }, (_, i) => i + 40),
  );
  assert.equal(f.adapter.calls.length, 2);
  assert.equal(f.state.hasMore, true);
});

test("gap filling joins sparse event sequences without requiring consecutive numbers", async (t) => {
  const f = await setup(t);
  f.adapter.events = events(0, 40).map((event) => ({
    ...event,
    seq: event.seq * 3,
  }));
  setHistoryEvents(f.state, f.adapter.events, false);
  f.drop();
  f.adapter.events = events(0, 140).map((event) => ({
    ...event,
    seq: event.seq * 3,
  }));
  await f.reopen();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 140 }, (_, i) => i * 3),
  );
  assert.equal(f.adapter.calls.length, 4);
  assert.equal(f.state.historyReload, null);
});

test("a gap larger than the older-page limit keeps both ends and every missing event", async (t) => {
  const f = await setup(t);
  f.drop();
  f.adapter.events = events(0, 1700);
  await f.reopen();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 1700 }, (_, i) => i),
  );
  assert.equal(f.state.hasMore, false);
  assert.equal(f.state.historyReload, null);
});

test("replacement history is already complete and must not be backfilled", async (t) => {
  const f = await setup(t, { provider: "codex" });
  const read = f.adapter.read;
  f.adapter.read = (payload) => ({ ...read(payload), replace: true });
  f.drop();
  f.adapter.events = events(0, 180);
  await f.reopen();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 40 }, (_, i) => 140 + i),
  );
  assert.equal(f.adapter.calls.length, 2);
  assert.equal(f.state.hasMore, true);
  assert.equal(f.state.historyReload, null);
});

test("gap projections commit only after every page succeeds and keep the newest cut", async (t) => {
  const f = await setup(t);
  const read = f.adapter.read;
  let fail = true;
  f.adapter.read = (payload) => {
    if (payload.beforeSeq === 60 && fail)
      throw new Error("Last page unavailable");
    const asOfSeq = payload.beforeSeq === 100 ? 200 : 179;
    return {
      ...read(payload),
      projections: { asOfSeq, values: { usage: asOfSeq } },
    };
  };
  f.drop();
  f.adapter.events = events(0, 180);
  await f.reopen();
  assert.match(f.state.historyReload?.error || "", /Last page unavailable/);
  assert.deepEqual(
    f.state.sessions.find((row) => row.sessionId === f.id).projections.values,
    {},
  );
  fail = false;
  await f.tick();
  assert.deepEqual(
    f.state.sessions.find((row) => row.sessionId === f.id).projections,
    { asOfSeq: 200, values: { usage: 200 } },
  );
  assert.equal(f.state.historyReload, null);
});

for (const stalled of ["empty", "same-page"])
  test(`non-advancing gap pages fail without clearing the reload; response = ${stalled}`, async (t) => {
    const f = await setup(t);
    const read = f.adapter.read;
    f.adapter.read = (payload) =>
      payload.beforeSeq === undefined
        ? read(payload)
        : stalled === "empty"
          ? { events: [], hasMore: true }
          : page(100, 140);
    f.drop();
    f.adapter.events = events(0, 140);
    await f.reopen();
    assert.match(f.state.historyReload?.error || "", /分页/);
    assert.deepEqual(
      f.seqs(),
      Array.from({ length: 40 }, (_, i) => i),
    );
    assert.equal(
      f.adapter.calls.length,
      3,
      "stop a non-advancing cursor immediately",
    );
  });

test("live arrivals and simultaneous older paging survive an atomic gap commit", async (t) => {
  const f = await setup(t, { initialCount: 80 });
  const pending = deferred(),
    read = f.adapter.read;
  f.adapter.read = (payload) =>
    payload.beforeSeq === 100 ? pending.promise : read(payload);
  f.drop();
  f.adapter.events = events(0, 180);
  await f.reopen();
  assert.ok(f.adapter.calls.some((call) => call.beforeSeq === 100));
  setHistoryEvents(f.state, mergeEvents(f.state.events, events(180, 181)));
  await f.invoke("older", { sessionId: f.id, requestId: "older-during-gap" });
  assert.ok(f.state.historyReload);
  assert.equal(f.state.hasMore, false);
  pending.resolve(page(60, 100));
  await flush();
  assert.deepEqual(
    f.seqs(),
    Array.from({ length: 181 }, (_, i) => i),
  );
  assert.equal(f.state.hasMore, false);
  assert.equal(f.state.historyReload, null);
});

test("switching chats discards an in-flight gap and stops its remaining requests", async (t) => {
  const f = await setup(t);
  const pending = deferred(),
    read = f.adapter.read;
  f.adapter.read = (payload) =>
    payload.beforeSeq === 100 ? pending.promise : read(payload);
  f.drop();
  f.adapter.events = events(0, 180);
  await f.reopen();
  assert.ok(f.adapter.calls.some((call) => call.beforeSeq === 100));
  await f.invoke("select", "other");
  pending.resolve(page(60, 100));
  await flush();
  assert.deepEqual(f.seqs(), [900]);
  assert.equal(f.state.historyReload, null);
  assert.ok(
    !f.adapter.calls.some((call) => call.beforeSeq === 60),
    "stale work must not continue paging the previous chat",
  );
});

test("a delayed older response cannot resurrect an exhausted cursor after gap filling", async (t) => {
  const f = await setup(t, { initialCount: 120 });
  const pending = deferred(),
    read = f.adapter.read;
  let failLatest = true,
    delayOlder = true;
  f.adapter.read = (payload) => {
    if (payload.beforeSeq === undefined && failLatest)
      throw new Error("Latest history unavailable");
    if (payload.beforeSeq === 80 && delayOlder) {
      delayOlder = false;
      return pending.promise;
    }
    return read(payload);
  };
  f.drop();
  await f.reopen();
  const older = f.invoke("older", { sessionId: f.id, requestId: "slow-older" });
  await f.invoke("older", { sessionId: f.id, requestId: "newer-request" });
  await f.invoke("older", { sessionId: f.id, requestId: "last-page" });
  failLatest = false;
  f.adapter.events = events(0, 180);
  await f.tick();
  assert.equal(f.state.hasMore, false);
  pending.resolve(page(40, 80, true));
  await older;
  assert.equal(f.state.hasMore, false);
  assert.equal(f.state.historyReload, null);
});

test("the real DSH transport fills a paged reconnect gap", async (t) => {
  const fixture = await createFixture({ historyPageSize: 40 });
  fixture.sessions.set("saved", {
    sessionId: "saved",
    running: false,
    blank: false,
    events: events(0, 40),
  });
  const client = new SessionClients();
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  await client.connect("dsh", fixture.endpoint);
  const state = mainState(client, "saved");
  const actions = mainActions({ client, state, connectionLifecycle: true });
  await actions.invoke("refresh");
  fixture.dropStreams();
  await until(() => state.connections.dsh.status === "reconnecting");
  fixture.sessions.get("saved").events = events(0, 140);
  await until(
    () =>
      state.connections.dsh.status === "connected" &&
      state.historyReload === null,
  );
  assert.deepEqual(
    Array.from(state.events, (event) => event.seq),
    Array.from({ length: 140 }, (_, i) => i),
  );
  assert.equal(state.hasMore, false);
});
