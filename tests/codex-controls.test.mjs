import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../shared/codex-client.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";

const savedTurn = (n, status = "completed") => ({
  id: `saved-${n}`,
  status,
  items: [],
});
const input = [{ type: "text", text: "continue" }];
const reply = (socket, frame, data, nextCursor = null) =>
  socket.send(JSON.stringify({ id: frame.id, result: { data, nextCursor } }));
const fail = (socket, frame, message) =>
  socket.send(
    JSON.stringify({ id: frame.id, error: { code: -32000, message } }),
  );
const mutations = (host) =>
  host.calls.filter((call) =>
    ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method),
  );
async function setup(t) {
  const host = await createCodexHost();
  const thread = host.add();
  const client = new CodexClient(host.endpoint);
  t.after(async () => {
    client.close();
    await host.close();
  });
  await client.connect();
  await client.list();
  return { host, thread, client, row: client.sessions.get(thread.id) };
}

function holdLatestPage(host, thread) {
  const waiting = Promise.withResolvers();
  let held = false;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list" || held) return false;
    held = true;
    const data = structuredClone(thread.turns).reverse().slice(0, 20);
    waiting.resolve(() => reply(socket, frame, data));
    return true;
  };
  return waiting.promise;
}

function nextFrame(client, type) {
  return new Promise((resolve) => {
    const listener = (frame) => {
      if (frame.payload.type !== type && frame.payload.event?.type !== type)
        return;
      client.off("frame", listener);
      resolve(frame);
    };
    client.on("frame", listener);
  });
}

for (const action of ["cancel", "steer", "start"]) {
  test(`${action} does not fetch failing old pages or advance display history`, async (t) => {
    const { host, thread, client, row } = await setup(t);
    thread.turns = [savedTurn(1)];
    await client.history(thread.id, false);
    const head = row.historyHead,
      cursor = row.cursor;
    thread.turns = Array.from({ length: 71 }, (_, i) => savedTurn(i + 1));
    if (action !== "start") thread.turns.at(-1).status = "inProgress";
    host.handler = (frame, socket) => {
      if (frame.method !== "thread/turns/list") return false;
      if (frame.params.cursor) fail(socket, frame, "older page unavailable");
      else
        reply(
          socket,
          frame,
          [...thread.turns].reverse().slice(0, 20),
          "saved-52",
        );
      return true;
    };
    const before = host.calls.length;
    await client.rpc(
      action === "cancel" ? "session.cancel" : "session.prompt",
      {
        sessionId: thread.id,
        content: input,
      },
    );
    const calls = host.calls.slice(before);
    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "thread/turns/list",
        action === "cancel" ? "turn/interrupt" : `turn/${action}`,
      ],
    );
    if (action !== "start")
      assert.equal(
        calls[1].params.turnId ?? calls[1].params.expectedTurnId,
        "saved-71",
      );
    assert.equal(row.historyHead, head);
    assert.equal(row.cursor, cursor);
    assert(
      !row.turns.has("saved-52"),
      "a control read must not publish an incomplete history window",
    );
    // A later display refresh must still fill every missing page.
    host.handler = null;
    const history = await client.history(thread.id, false);
    assert.deepEqual(
      history.events
        .filter(({ event }) => event.type === "turn/start")
        .map(({ event }) => event.data.turn),
      thread.turns.map((turn) => turn.id),
    );
  });
}

test("an unavailable latest page still blocks a write instead of using the cached active turn", async (t) => {
  const { host, thread, client } = await setup(t);
  thread.turns = [savedTurn(1, "inProgress")];
  await client.history(thread.id, false);
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    fail(socket, frame, "latest page unavailable");
    return true;
  };
  await assert.rejects(
    client.rpc("session.cancel", { sessionId: thread.id }),
    /latest page unavailable/,
  );
  assert.deepEqual(mutations(host), []);
});

test("an old cached active turn outside the latest page cannot steal a new prompt", async (t) => {
  const { host, thread, client } = await setup(t);
  thread.turns = [savedTurn(1, "inProgress")];
  await client.history(thread.id, false);
  thread.turns = Array.from({ length: 71 }, (_, i) => savedTurn(i + 1));
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (frame.params.cursor) fail(socket, frame, "older page unavailable");
    else
      reply(
        socket,
        frame,
        [...thread.turns].reverse().slice(0, 20),
        "saved-52",
      );
    return true;
  };
  await client.rpc("session.prompt", { sessionId: thread.id, content: input });
  assert.deepEqual(
    mutations(host).map((call) => call.method),
    ["turn/start"],
  );
});

test(
  "a live completion during confirmation prevents cancelling the finished turn",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client } = await setup(t);
    thread.turns = [savedTurn(1, "inProgress")];
    await client.history(thread.id, false);
    const held = holdLatestPage(host, thread);
    const rejected = assert.rejects(
      client.rpc("session.cancel", { sessionId: thread.id }),
      /没有正在运行/,
    );
    const release = await held;
    const completed = nextFrame(client, "turn/end");
    host.finish(thread.id, thread.turns[0]);
    await completed;
    release();
    await rejected;
    assert.deepEqual(mutations(host), []);
  },
);

test(
  "a new live turn during confirmation receives the prompt as a steer",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client } = await setup(t);
    thread.turns = [savedTurn(1)];
    await client.history(thread.id, false);
    const held = holdLatestPage(host, thread);
    const sending = client.rpc("session.prompt", {
      sessionId: thread.id,
      content: input,
    });
    const release = await held;
    const started = nextFrame(client, "turn/start");
    const turn = host.start(thread.id);
    await started;
    release();
    await sending;
    assert.deepEqual(
      mutations(host).map((call) => call.method),
      ["turn/steer"],
    );
    assert.equal(mutations(host)[0].params.expectedTurnId, turn.id);
  },
);

for (const source of ["history", "control"]) {
  test(
    `a newer ${source} read wins over a delayed active-turn confirmation`,
    { timeout: 5000 },
    async (t) => {
      const { host, thread, client } = await setup(t);
      thread.turns = [savedTurn(1, "inProgress")];
      await client.history(thread.id, false);
      const held = holdLatestPage(host, thread);
      const rejected = assert.rejects(
        client.rpc("session.cancel", { sessionId: thread.id }),
        /没有正在运行/,
      );
      const release = await held;
      thread.turns[0].status = "completed";
      if (source === "history") await client.history(thread.id, false);
      else
        await assert.rejects(
          client.rpc("session.cancel", { sessionId: thread.id }),
          /没有正在运行/,
        );
      release();
      await rejected;
      assert.deepEqual(mutations(host), []);
    },
  );
}

for (const change of ["unloaded", "input-disabled"]) {
  test(
    `a thread becoming ${change} during confirmation blocks the prompt`,
    { timeout: 5000 },
    async (t) => {
      const { host, thread, client } = await setup(t);
      thread.turns = [savedTurn(1)];
      const held = holdLatestPage(host, thread);
      const rejected = assert.rejects(
        client.rpc("session.prompt", { sessionId: thread.id, content: input }),
        /会话已更换|暂不接受|仅支持查看/,
      );
      const release = await held;
      if (change === "unloaded") {
        const changed = nextFrame(client, "host/session-status");
        host.notify("thread/status/changed", {
          threadId: thread.id,
          status: { type: "notLoaded" },
        });
        await changed;
      } else {
        thread.canAcceptDirectInput = false;
        await client.list();
      }
      release();
      await rejected;
      assert.deepEqual(mutations(host), []);
    },
  );
}

test(
  "disconnecting during confirmation never sends a prompt",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client } = await setup(t);
    const held = holdLatestPage(host, thread);
    const rejected = assert.rejects(
      client.rpc("session.prompt", { sessionId: thread.id, content: input }),
      /连接/,
    );
    await held;
    host.disconnect();
    await rejected;
    assert.deepEqual(mutations(host), []);
  },
);
