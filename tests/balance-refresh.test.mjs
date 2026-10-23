import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBalanceRefresher } from "../electron/balance.mjs";
import { SessionClients } from "../shared/session-clients.mjs";

const balance = (total) => ({
  ok: true,
  balances: [{ currency: "CNY", total }],
  updatedAt: total * 1000,
});

class Adapter extends EventEmitter {
  streams = new Set();
  requests = [];
  async connect() {
    this.stream("mux", true);
    this.stream("host", true);
    return { version: "test" };
  }
  stream(kind, connected) {
    if (connected) this.streams.add(kind);
    else this.streams.delete(kind);
    this.emit("stream", { kind, connected });
  }
  balance() {
    return new Promise((resolve, reject) => {
      this.requests.push({ resolve, reject });
    });
  }
  close() {
    this.streams.clear();
    this.removeAllListeners();
  }
}

async function setup(t) {
  const adapters = [];
  const client = new SessionClients({
    factory: () => {
      const adapter = new Adapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  t.after(() => client.close());
  await client.connect("dsh", "old");
  const state = {
    connections: client.connections(),
    balance: balance(5),
    balanceError: "",
  };
  client.on("status", () => {
    state.connections = client.connections();
  });
  const published = [];
  const snapshot = () =>
    structuredClone({ balance: state.balance, error: state.balanceError });
  const refresh = createBalanceRefresher({
    client,
    state,
    broadcast: () => published.push(snapshot()),
  });
  const start = (adapter = adapters.at(-1)) => {
    const done = refresh();
    return { ...adapter.requests.at(-1), done };
  };
  return { client, adapters, state, published, snapshot, refresh, start };
}

for (const outcome of ["resolve", "reject"]) {
  test(`late balance ${outcome} after reconnect leaves fresh balance healthy`, async (t) => {
    const { client, adapters, state, published, snapshot, start } =
      await setup(t);
    const row = client.entries.get("dsh"),
      epoch = row.epoch,
      old = start();
    adapters[0].stream("mux", false);
    adapters[0].stream("mux", true);
    assert.equal(client.entries.get("dsh"), row);
    assert.notEqual(
      row.epoch,
      epoch,
      "reconnect reuses the row with a new epoch",
    );

    const fresh = start();
    fresh.resolve(balance(20));
    await fresh.done;
    assert.deepEqual(state.balance, balance(20));
    assert.equal(state.balanceError, "");
    const expected = snapshot();

    // A delayed success is rejected by SessionClients' epoch check; a network
    // failure bypasses that check. Neither may publish an obsolete error.
    old[outcome](
      outcome === "resolve" ? balance(10) : new Error("old HTTP 404"),
    );
    await old.done;
    assert.deepEqual(snapshot(), expected);
    assert.equal(published.length, 1, "obsolete completion must not broadcast");
  });
}

for (const newerFails of [false, true]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`overlapping balance refreshes keep newer ${newerFails ? "error" : "success"} after older ${outcome}`, async (t) => {
      const { state, published, snapshot, start } = await setup(t);
      const old = start(),
        fresh = start();
      if (newerFails) fresh.reject(new Error("current service unavailable"));
      else fresh.resolve(balance(20));
      await fresh.done;
      assert.equal(
        state.balanceError,
        newerFails ? "current service unavailable" : "",
      );
      assert.deepEqual(state.balance, balance(newerFails ? 5 : 20));
      const expected = snapshot();

      old[outcome](
        outcome === "resolve" ? balance(10) : new Error("old HTTP 404"),
      );
      await old.done;
      assert.deepEqual(snapshot(), expected);
      assert.equal(published.length, 1);
    });
  }
}

for (const change of ["reconnect", "replace", "disconnect"]) {
  test(`balance completion after ${change} is ignored even without a newer refresh`, async (t) => {
    const { client, adapters, published, snapshot, refresh, start } =
      await setup(t);
    const old = start();
    if (change === "reconnect") {
      adapters[0].stream("mux", false);
      adapters[0].stream("mux", true);
    } else if (change === "replace") {
      await client.connect("dsh", "new");
    } else {
      client.disconnect("dsh");
      await refresh();
      assert.equal(
        adapters[0].requests.length,
        1,
        "offline refresh sends no request",
      );
    }
    const expected = snapshot();
    old.resolve(balance(10));
    await old.done;
    assert.deepEqual(snapshot(), expected);
    assert.equal(published.length, 0);
  });
}

test("current balance failures and stale data remain visible and recover on success", async (t) => {
  const { state, published, start } = await setup(t);
  const missing = start();
  missing.reject(new Error("HTTP 404"));
  await missing.done;
  assert.equal(state.balanceError, "尚未安装余额插件");
  assert.deepEqual(state.balance, balance(5));

  const invalid = start();
  invalid.resolve({ ok: true, balances: [{ currency: "CNY", total: "10" }] });
  await invalid.done;
  assert.equal(state.balanceError, "余额响应格式不兼容");
  assert.deepEqual(state.balance, balance(5));

  const stale = start(),
    cached = { ...balance(10), stale: true, error: "余额服务暂不可用" };
  stale.resolve(cached);
  await stale.done;
  assert.deepEqual(state.balance, cached);
  assert.equal(state.balanceError, cached.error);

  const fresh = start();
  fresh.resolve(balance(20));
  await fresh.done;
  assert.deepEqual(state.balance, balance(20));
  assert.equal(state.balanceError, "");
  assert.equal(published.length, 4);
});
