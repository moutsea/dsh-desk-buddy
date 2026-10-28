import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionClients, sessionKey } from "../shared/session-clients.mjs";
import { mainActions } from "./helpers/main-actions.mjs";

const page = (text) => ({
  events: [
    {
      event: {
        seq: 1,
        type: "user/message",
        data: { content: [{ type: "text", text }] },
      },
    },
  ],
  hasMore: false,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

class RestorationAdapter extends EventEmitter {
  streams = new Set();
  failList = true;
  historyFailures = 0;
  calls = [];
  items = [{ sessionId: "saved", running: false, blank: false }];
  history = () => page("Existing conversation");
  async connect() {
    for (const kind of ["mux", "host"]) {
      this.streams.add(kind);
      this.emit("stream", { kind, connected: true });
    }
    return { version: "fixture", cwd: "/tmp" };
  }
  async rpc(method, payload) {
    this.calls.push({ method, payload });
    if (method === "session.list") {
      if (this.failList) throw new Error("List temporarily unavailable");
      return { items: this.items };
    }
    if (method === "session.history") {
      if (this.historyFailures-- > 0)
        throw new Error("History temporarily unavailable");
      return this.history();
    }
    throw new Error(`Unexpected method ${method}`);
  }
  close() {
    this.removeAllListeners();
  }
}

async function setup(t, provider, connectionLifecycle = false) {
  const adapter = new RestorationAdapter();
  const client = new SessionClients({ factory: () => adapter });
  t.after(() => client.close());
  await client.connect(provider, "fixture");
  const id = sessionKey(provider, "saved");
  const state = {
    config: { provider, selectedId: id },
    selectedId: "",
    sessions: [],
    events: [],
    eventsRevision: 0,
    liveAssistant: {},
    activity: {},
    connections: client.connections(),
    connection: "connected",
    connectionEpoch: 1,
    pending: [],
    completions: [],
    taskSounds: [],
    hasMore: false,
    surface: { section: "chat" },
  };
  const actions = mainActions({ client, state, connectionLifecycle });
  return {
    adapter,
    client,
    id,
    state,
    ...actions,
    async tick() {
      actions.poll();
      await flush();
    },
    historyCalls() {
      return adapter.calls.filter((call) => call.method === "session.history");
    },
    async recoverList() {
      adapter.failList = false;
      client.entries.get(provider).lastRefresh = 0;
      actions.poll();
      await flush();
    },
  };
}

for (const provider of ["dsh", "codex"])
  for (const historyFailures of [0, 1])
    test(`background selection restoration loads history and retries failures; provider = ${provider}, failures = ${historyFailures}`, async (t) => {
      const f = await setup(t, provider);
      await f.refreshSessions(f.client, false, provider);
      assert.equal(f.state.selectedId, "");
      assert.equal(f.state.connections[provider].sessionsReady, false);
      f.adapter.historyFailures = historyFailures;
      await f.recoverList();
      assert.equal(f.state.selectedId, f.id);
      assert.equal(f.state.connections[provider].sessionsReady, true);
      assert.ok(
        f.state.historyReload,
        "restoration must register a pending history load",
      );
      await f.tick();
      if (historyFailures) {
        assert.match(
          f.state.historyReload.error,
          /History temporarily unavailable/,
        );
        assert.equal(f.historyReloads.needsRetry(f.id), true);
        await f.tick();
      }
      assert.equal(
        f.state.events[0]?.data.content[0].text,
        "Existing conversation",
      );
      assert.equal(f.state.historyReload, null);
      assert.equal(f.historyCalls().length, historyFailures + 1);
      assert.equal(f.historyCalls()[0].payload.sessionId, "saved");
      await f.tick();
      assert.equal(
        f.historyCalls().length,
        historyFailures + 1,
        "an idle writable chat does not need repeated history reads",
      );
    });

test("a restored selection keeps its pending history load while the panel is closed", async (t) => {
  const f = await setup(t, "dsh");
  f.state.surface.section = null;
  await f.recoverList();
  await f.tick();
  assert.equal(f.historyCalls().length, 0);
  assert.ok(f.state.historyReload);
  f.state.surface.section = "chat";
  await f.tick();
  assert.equal(
    f.state.events[0]?.data.content[0].text,
    "Existing conversation",
  );
});

for (const provider of ["dsh", "codex"])
  test(`an older read cannot satisfy a later restoration of the same selection; provider = ${provider}`, async (t) => {
    const f = await setup(t, provider);
    let release;
    f.adapter.history = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await f.recoverList();
    await f.tick();
    assert.equal(typeof release, "function");
    await f.tick();
    assert.equal(
      f.historyCalls().length,
      1,
      "pending history must not be duplicated",
    );
    f.adapter.items = [];
    await f.refreshSessions(f.client, false, provider);
    assert.equal(f.state.selectedId, "");
    f.adapter.items = [{ sessionId: "saved", running: false, blank: false }];
    await f.refreshSessions(f.client, false, provider);
    release(page("Stale history"));
    await flush();
    assert.equal(f.state.events.length, 0);
    assert.ok(f.state.historyReload);
    f.adapter.history = () => page("Fresh history");
    await f.tick();
    assert.equal(f.state.events[0]?.data.content[0].text, "Fresh history");
    assert.equal(f.state.historyReload, null);
  });

async function reconnection(t, provider) {
  const f = await setup(t, provider, true);
  f.adapter.failList = false;
  await f.invoke("refresh");
  const restoredPage = {
    events: [
      ...page("Existing conversation").events,
      {
        event: {
          ...page("Finished while disconnected").events[0].event,
          seq: 2,
        },
      },
    ],
    hasMore: false,
  };
  f.adapter.history = () => restoredPage;
  return {
    ...f,
    drop() {
      f.adapter.streams.delete("mux");
      f.adapter.emit("stream", { kind: "mux", connected: false });
    },
    async reopen() {
      f.adapter.streams.add("mux");
      f.adapter.emit("stream", { kind: "mux", connected: true });
      await flush();
    },
    texts() {
      return Array.from(f.state.events, (event) => event.data.content[0].text);
    },
  };
}

for (const provider of ["dsh", "codex"])
  test(`automatic ${provider} reconnection retries failed history reads until the current history loads`, async (t) => {
    const f = await reconnection(t, provider);
    f.adapter.historyFailures = 2;
    f.drop();
    assert.equal(f.state.selectedId, f.id);
    assert.deepEqual(
      f.texts(),
      ["Existing conversation"],
      "keep the displayed history while reconnecting",
    );
    assert.ok(
      f.state.historyReload,
      "the retained selection must have a pending reload",
    );
    assert.equal(f.state.historyReload.retainsHistory, true);
    await f.tick();
    assert.equal(
      f.historyCalls().length,
      1,
      "do not read through a disconnected transport",
    );
    await f.reopen();
    assert.equal(f.state.connections[provider].status, "connected");
    assert.match(
      f.state.historyReload.error,
      /History temporarily unavailable/,
    );
    assert.equal(f.historyCalls().length, 2);
    assert.equal(f.state.historyReload.retainsHistory, true);
    await f.tick();
    assert.equal(f.historyCalls().length, 3);
    assert.match(
      f.state.historyReload.error,
      /History temporarily unavailable/,
    );
    await f.tick();
    assert.deepEqual(f.texts(), [
      "Existing conversation",
      "Finished while disconnected",
    ]);
    assert.equal(f.state.historyReload, null);
    assert.equal(f.historyCalls().length, 4);
    await f.tick();
    assert.equal(
      f.historyCalls().length,
      4,
      "an idle writable chat stops retrying after success",
    );
  });

for (const provider of ["dsh", "codex"])
  for (const staleOutcome of ["success", "failure"])
    test(`a ${provider} read from an earlier reconnection cannot settle the current reload; stale outcome = ${staleOutcome}`, async (t) => {
      const f = await reconnection(t, provider);
      const reads = [];
      f.adapter.history = () =>
        new Promise((resolve, reject) => reads.push({ resolve, reject }));
      f.drop();
      await f.reopen();
      assert.equal(reads.length, 1);
      f.drop();
      await f.reopen();
      assert.equal(reads.length, 2);
      if (staleOutcome === "success") reads[0].resolve(page("Stale snapshot"));
      else reads[0].reject(new Error("Stale read failed"));
      await flush();
      assert.deepEqual(f.texts(), ["Existing conversation"]);
      assert.ok(f.state.historyReload);
      assert.equal(
        f.state.historyReload.error,
        "",
        "old failures must not leak into the new connection",
      );
      await f.tick();
      assert.equal(
        reads.length,
        2,
        "polling must not duplicate an active reconnect read",
      );
      reads[1].reject(new Error("Current read failed"));
      await flush();
      assert.match(f.state.historyReload.error, /Current read failed/);
      await f.tick();
      assert.equal(reads.length, 3);
      reads[2].resolve(page("Fresh snapshot"));
      await flush();
      assert.deepEqual(f.texts(), ["Fresh snapshot"]);
      assert.equal(f.state.historyReload, null);
      await f.tick();
      assert.equal(reads.length, 3);
    });

test("a failed reconnect reload waits while the panel is hidden and resumes when chat opens", async (t) => {
  const f = await reconnection(t, "dsh");
  f.state.surface.section = null;
  f.adapter.historyFailures = 1;
  f.drop();
  await f.reopen();
  assert.match(f.state.historyReload.error, /History temporarily unavailable/);
  await f.tick();
  assert.equal(f.historyCalls().length, 2);
  f.state.surface.section = "chat";
  await f.tick();
  assert.deepEqual(f.texts(), [
    "Existing conversation",
    "Finished while disconnected",
  ]);
  assert.equal(f.state.historyReload, null);
});

test("resetting another provider preserves the selected chat's reconnect reload", async (t) => {
  const f = await reconnection(t, "dsh");
  f.adapter.historyFailures = 1;
  f.drop();
  await f.reopen();
  const pending = f.historyReloads.snapshot(f.id);
  assert.match(pending.error, /History temporarily unavailable/);
  const other = new RestorationAdapter();
  other.failList = false;
  f.client.factory = () => other;
  await f.client.connect("codex", "fixture");
  await flush();
  assert.equal(f.state.selectedId, f.id);
  assert.deepEqual(f.historyReloads.snapshot(f.id), pending);
  assert.equal(f.historyCalls().length, 2);
  await f.tick();
  assert.deepEqual(f.texts(), [
    "Existing conversation",
    "Finished while disconnected",
  ]);
  assert.equal(f.state.historyReload, null);
});
