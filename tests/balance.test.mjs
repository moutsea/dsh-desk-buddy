import test from "node:test";
import assert from "node:assert/strict";
import {
  createBalanceReader,
  apply,
} from "../plugins/dsh-girl-bridge/index.mjs";
const response = () =>
  Response.json({
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "12.50",
        granted_balance: "2.5",
        topped_up_balance: "10",
      },
      {
        currency: "USD",
        total_balance: "3",
        granted_balance: "0",
        topped_up_balance: "3",
      },
    ],
  });
test("balance queries stay server-side, coalesce requests and retain currencies", async () => {
  let calls = 0;
  const read = createBalanceReader(
    {
      resolve: async (name) => {
        assert.equal(name, "DEEPSEEK_API_KEY");
        return { value: "test-secret" };
      },
    },
    async (_url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      return response();
    },
  );
  const [a, b] = await Promise.all([read(), read()]);
  await read();
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(
    a.balances.map((row) => row.currency),
    ["CNY", "USD"],
  );
  assert.ok(!JSON.stringify(a).includes("test-secret"));
});
test("no key, upstream errors and stale data are explicit without leaking upstream details", async () => {
  const noKey = createBalanceReader({ resolve: async () => null }, () => {
    throw new Error("should not fetch");
  });
  assert.equal((await noKey()).code, "NO_KEY");
  let time = 100,
    failed = false;
  const read = createBalanceReader(
    { resolve: async () => ({ value: "secret" }) },
    async () => {
      if (failed) throw new Error("private-secret-in-upstream-error");
      return response();
    },
    () => time,
  );
  await read();
  failed = true;
  time = 61000;
  const stale = await read();
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, 100);
  assert.ok(!JSON.stringify(stale).includes("private-secret"));
});
test("plugin route registers and disposes, rejects cross-origin reads and writes", async () => {
  let route,
    cleanup,
    disposed = false;
  apply({
    credentials: { resolve: async () => null },
    webServer: {
      register: (value) => {
        route = value;
        return () => {
          disposed = true;
        };
      },
    },
    effect: (effect) => {
      cleanup = effect();
    },
  });
  const run = async (request) => {
    let code, data;
    await route.handler(request, {
      writeHead: (value) => {
        code = value;
      },
      end: (value) => {
        data = value;
      },
    });
    return { code, data };
  };
  assert.equal(
    (await run({ method: "GET", headers: { host: "127.0.0.1:3080" } })).code,
    200,
  );
  assert.equal((await run({ method: "POST", headers: {} })).code, 405);
  assert.equal(
    (
      await run({
        method: "GET",
        headers: { origin: "http://evil.test", host: "127.0.0.1:3080" },
      })
    ).code,
    403,
  );
  assert.equal(
    (
      await run({
        method: "GET",
        headers: { origin: "http://evil.test", host: "evil.test" },
      })
    ).code,
    403,
  );
  cleanup();
  assert.equal(disposed, true);
});
