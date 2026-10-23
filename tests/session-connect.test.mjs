import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { SessionClients } from "../shared/session-clients.mjs";
import { createFixture } from "./fixture.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(5);
  }
  assert.fail("condition timed out");
}
class Adapter extends EventEmitter {
  streams = new Set();
  closed = false;
  gate = deferred();
  host = { version: "test", cwd: "/tmp" };
  async connect() {
    await this.gate.promise;
    return this.host;
  }
  open(kind) {
    this.streams.add(kind);
    this.emit("stream", { kind, connected: true });
  }
  ready() {
    this.open("mux");
    this.open("host");
    this.gate.resolve();
  }
  frame(payload, rpcId) {
    this.emit("frame", { payload, rpcId });
  }
  close() {
    this.closed = true;
    this.removeAllListeners();
  }
  async respond() {
    return { accepted: true };
  }
}
function setup(t, options) {
  const adapters = [];
  const client = new SessionClients({
    ...options,
    factory: () => {
      const a = new Adapter();
      adapters.push(a);
      return a;
    },
  });
  t.after(() => client.close());
  return { client, adapters };
}

test("internal polling hints never enter the DSH list protocol", async (t) => {
  const { client, adapters } = setup(t);
  const connection = client.connect("dsh", "host");
  adapters[0].ready();
  await connection;
  const calls = [];
  adapters[0].rpc = async (method, payload) => {
    assert.equal(method, "session.list");
    calls.push(payload);
    assert.deepEqual(payload, {});
    return { items: [] };
  };
  await client.list();
  client.entries.get("dsh").lastRefresh = 0;
  await client.list({ poll: true });
  assert.equal(calls.length, 2);
});

test("replacement waits for host and both streams, retaining old approvals until commit", async (t) => {
  const { client, adapters } = setup(t);
  const first = client.connect("dsh", "old");
  adapters[0].ready();
  await first;
  const old = client.entries.get("dsh"),
    frames = [],
    order = [];
  client.on("frame", (f) => {
    frames.push(f);
    order.push("frame");
  });
  client.on("reset", () => order.push("reset"));
  client.on("stream-start", () => order.push("stream-start"));
  adapters[0].frame(
    { type: "approval/requested", sessionId: "s", approvalId: "old" },
    "old",
  );
  const pending = frames.at(-1).rpcId;
  const replacement = client.connect("dsh", "new"),
    candidate = adapters[1];
  candidate.emit("stream-start", { kind: "mux" });
  candidate.open("mux");
  candidate.frame(
    { type: "approval/requested", sessionId: "s", approvalId: "new" },
    "new",
  );
  candidate.gate.resolve();
  await delay(0);
  assert.equal(client.entries.get("dsh"), old);
  assert.equal(adapters[0].closed, false);
  assert.equal(frames.length, 1, "candidate frames stay private");
  await client.respond(pending, { sessionId: "s", outcome: "allow" });
  order.length = 0;
  candidate.open("host");
  await replacement;
  assert.equal(adapters[0].closed, true);
  assert.deepEqual(order, ["reset", "stream-start", "frame"]);
  assert.equal(client.pending.size, 1);
  await assert.rejects(client.respond(pending, { sessionId: "s" }), /失效/);
  await client.respond(frames.at(-1).rpcId, {
    sessionId: "s",
    outcome: "allow",
  });
});

test("failed DSH stream handshake preserves working connection and its state", async (t) => {
  const oldHost = await createFixture(),
    badHost = await createFixture();
  badHost.setStreamsAvailable(false);
  const client = new SessionClients();
  t.after(async () => {
    client.close();
    await Promise.all([oldHost.close(), badHost.close()]);
  });
  await client.connect("dsh", oldHost.endpoint);
  const row = client.entries.get("dsh"),
    epoch = row.epoch;
  let resets = 0;
  client.on("reset", () => resets++);
  await assert.rejects(client.connect("dsh", badHost.endpoint), /事件连接/);
  assert.equal(client.entries.get("dsh"), row);
  assert.equal(row.epoch, epoch);
  assert.equal(row.status, "connected");
  assert.equal(resets, 0);
  assert.equal(
    (await client.rpc("session.create", { provider: "dsh", cwd: "/tmp" }))
      .provider,
    "dsh",
  );
});

test("timed out replacement, superseded attempts and disconnect cannot install late candidates", async (t) => {
  const { client, adapters } = setup(t, { connectTimeout: 30 });
  const first = client.connect("codex", "old");
  adapters[0].ready();
  await first;
  const row = client.entries.get("codex");
  await assert.rejects(client.connect("codex", "timeout"), /超时/);
  assert.equal(client.entries.get("codex"), row);
  assert(adapters[1].closed);
  const slow = client.connect("codex", "slow");
  const fast = client.connect("codex", "fast");
  adapters[3].ready();
  await fast;
  adapters[2].ready();
  assert.equal(await slow, undefined);
  assert.equal(client.entries.get("codex").client, adapters[3]);
  const canceled = client.connect("codex", "canceled");
  client.disconnect("codex");
  adapters[4].ready();
  assert.equal(await canceled, undefined);
  assert.equal(client.connections().codex.status, "offline");
});

test("superseding an initial connection does not retain a phantom connecting row", async (t) => {
  const { client, adapters } = setup(t, { connectTimeout: 30 });
  const first = client.connect("dsh", "slow");
  const second = client.connect("dsh", "bad");
  await assert.rejects(second, /超时/);
  assert.equal(await first, undefined);
  assert.equal(client.connections().dsh.status, "offline");
  const third = client.connect("dsh", "cancel");
  client.close();
  adapters[2].ready();
  await third;
  assert.equal(client.connections().dsh.status, "offline");
});

test("cancellation and timeout settle even when streams precede an unresolved host handshake", async (t) => {
  const { client, adapters } = setup(t, { connectTimeout: 30 });
  const timed = client.connect("codex", "slow-host");
  adapters[0].open("mux");
  adapters[0].open("host");
  await assert.rejects(timed, /超时/);
  const canceled = client.connect("codex", "slow-host");
  adapters[1].open("mux");
  adapters[1].open("host");
  client.disconnect("codex");
  assert.equal(await canceled, undefined);
  assert.equal(client.connections().codex.status, "offline");
  adapters.forEach((a) => a.gate.resolve());
});

test("history seeding stays bounded across overlapping refreshes and skips superseded queued work", async (t) => {
  const { client, adapters } = setup(t, { historyConcurrency: 2 });
  const connection = client.connect("codex", "host");
  adapters[0].ready();
  await connection;
  const adapter = adapters[0],
    gates = [],
    calls = [];
  let active = 0,
    maximum = 0,
    lists = 0;
  adapter.rpc = async (method, input) => {
    if (method === "session.list") {
      lists++;
      return {
        items: Array.from({ length: 10 }, (_, i) => ({
          sessionId: `s${i}`,
          running: true,
          followRevision: 1,
        })),
      };
    }
    calls.push(input.sessionId);
    active++;
    maximum = Math.max(maximum, active);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    active--;
    return {
      events: [{ event: { seq: 1, type: "turn/start", data: { turn: 1 } } }],
    };
  };
  t.after(() => gates.forEach((g) => g.resolve()));
  const first = client.list();
  await until(() => gates.length === 2);
  client.entries.get("codex").lastRefresh = 0;
  await client.list({ poll: true });
  assert.equal(lists, 1, "poll does not supersede slow seed");
  const second = client.list();
  await until(() => lists === 2);
  for (let batch = 0; batch < 6; batch++) {
    await until(() => gates.length === (batch + 1) * 2);
    gates[batch * 2].resolve();
    gates[batch * 2 + 1].resolve();
  }
  await Promise.all([first, second]);
  assert.equal(maximum, 2);
  assert.equal(calls.length, 12, "only two superseded reads actually ran");
  assert.equal(client.entries.get("codex").sessions.length, 10);
  await client.list();
  assert.equal(calls.length, 12, "seeded revisions are cached");
});
