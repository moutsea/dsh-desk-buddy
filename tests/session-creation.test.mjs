import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionClients } from "../shared/session-clients.mjs";
import { mainActions } from "./helpers/main-actions.mjs";

const setup = (failedRead) => {
  const state = {
    selectedId: "",
    sessions: [],
    events: [],
    eventsRevision: 0,
    liveAssistant: {},
    hasMore: false,
    activity: {},
    connections: { dsh: { status: "connected" } },
    config: { provider: "dsh", cwd: "/tmp" },
  };
  let fail = failedRead;
  const calls = [];
  const client = {
    connections: () => state.connections,
    async rpc(method) {
      calls.push(method);
      if (method === fail) throw new Error(`${method} unavailable`);
      if (method === "session.create") return { sessionId: "created" };
      if (method === "session.list")
        return { items: [{ sessionId: "created", running: false }] };
      if (method === "session.history") return { events: [], hasMore: false };
      if (method === "session.prompt") return {};
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return {
    state,
    calls,
    ...mainActions({ client, state }),
    recover() {
      fail = null;
    },
  };
};

for (const failedRead of ["session.history", "session.list"])
  test(`successful creation survives ${failedRead} failure and remains writable`, async () => {
    const f = setup(failedRead);
    const id = await f.invoke("create", {
      provider: "dsh",
      requestId: "creation-1",
    });
    assert.equal(id, "created");
    assert.equal(f.state.selectedId, id);
    assert.ok(f.state.sessions.some((row) => row.sessionId === id));
    assert.deepEqual(f.published.at(-1).sessionCreation, {
      requestId: "creation-1",
      sessionId: id,
    });
    if (failedRead === "session.history") {
      assert.match(f.state.historyReload.error, /session.history unavailable/);
      assert.equal(f.historyReloads.needsRetry(id), true);
    }
    await f.invoke("send", { sessionId: id, text: "First message" });
    assert.equal(
      f.calls.filter((method) => method === "session.create").length,
      1,
    );
    assert.equal(
      f.calls.filter((method) => method === "session.prompt").length,
      1,
    );
    f.recover();
    await f.invoke("refresh");
    assert.equal(f.state.historyReload, null);
  });

test("failed creation does not publish a successful creation receipt or select a session", async () => {
  const f = setup("session.create");
  await assert.rejects(
    f.invoke("create", { requestId: "failed" }),
    /session.create unavailable/,
  );
  assert.equal(f.state.selectedId, "");
  assert.equal(f.state.sessionCreation, undefined);
  assert.equal(f.published.length, 0);
});

class CreationAdapter extends EventEmitter {
  streams = new Set();
  async connect() {
    for (const kind of ["mux", "host"]) {
      this.streams.add(kind);
      this.emit("stream", { kind, connected: true });
    }
    return { version: "test" };
  }
  async rpc(method) {
    if (method === "session.create") return { sessionId: "created" };
    if (method === "session.list") return { items: [] };
    throw new Error(`Unexpected method ${method}`);
  }
  remove() {
    this.emit("frame", {
      payload: { type: "host/session-removed", sessionId: "created" },
    });
  }
  close() {
    this.removeAllListeners();
  }
}
async function connected(t) {
  const adapter = new CreationAdapter();
  const client = new SessionClients({ factory: () => adapter });
  t.after(() => client.close());
  await client.connect("dsh", "test");
  return { adapter, client };
}

test("failed lists retain a confirmed creation in the session cache", async (t) => {
  const { adapter, client } = await connected(t);
  const original = adapter.rpc.bind(adapter);
  adapter.rpc = (method, payload) =>
    method === "session.list"
      ? Promise.reject(new Error("List unavailable"))
      : original(method, payload);
  const created = await client.rpc("session.create", {
    provider: "dsh",
    cwd: "/tmp",
  });
  const result = await client.rpc("session.list");
  assert.equal(result.items[0].sessionId, created.sessionId);
  assert.equal(result.items[0].cwd, "/tmp");
});

for (const removed of [false, true])
  test(`a list begun before creation cannot overwrite its newer outcome; removed = ${removed}`, async (t) => {
    const { adapter, client } = await connected(t);
    const original = adapter.rpc.bind(adapter);
    let release;
    adapter.rpc = (method, payload) =>
      method === "session.list"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(method, payload);
    const listing = client.rpc("session.list");
    const created = await client.rpc("session.create", {
      provider: "dsh",
      cwd: "/tmp",
    });
    if (removed) adapter.remove();
    release({ items: [] });
    assert.equal(
      (await listing).items.some((row) => row.sessionId === created.sessionId),
      !removed,
    );
    adapter.rpc = original;
    assert.deepEqual(
      (await client.rpc("session.list")).items,
      [],
      "a subsequent successful list is authoritative",
    );
  });

for (const lateBoundary of [undefined, "turn/start", "turn/end"])
  test(`a delayed creation acknowledgement cannot resurrect an already removed session; late boundary = ${lateBoundary}`, async (t) => {
    const { adapter, client } = await connected(t);
    let release;
    adapter.rpc = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const creation = client.rpc("session.create", {
      provider: "dsh",
      cwd: "/tmp",
    });
    adapter.remove();
    if (lateBoundary)
      adapter.emit("frame", {
        payload: {
          type: "session/event",
          sessionId: "created",
          event: {
            seq: 1,
            type: lateBoundary,
            data: { turn: 1, reason: { kind: "completed" } },
          },
        },
      });
    release({ sessionId: "created" });
    await assert.rejects(creation, /已被移除/);
    assert.deepEqual(client.entries.get("dsh").sessions, []);
  });
