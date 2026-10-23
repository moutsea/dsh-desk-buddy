import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../shared/codex-client.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";

const turns = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `saved-${i + 1}`,
    status: "completed",
    items: [
      { id: `message-${i + 1}`, type: "agentMessage", text: `reply ${i + 1}` },
    ],
  }));
const ids = (result) =>
  result.events
    .filter(({ event }) => event.type === "turn/start")
    .map(({ event }) => event.data.turn);
const reply = (socket, frame, result) =>
  socket.send(JSON.stringify({ id: frame.id, result }));
function historyPage(thread, frame) {
  const ordered = [...thread.turns].reverse();
  const offset = frame.params.cursor
    ? ordered.findIndex((turn) => turn.id === frame.params.cursor) + 1
    : 0;
  const data = ordered.slice(offset, offset + frame.params.limit);
  return {
    data,
    nextCursor: offset + data.length < ordered.length ? data.at(-1).id : null,
  };
}
async function setup(t, count = 2) {
  const host = await createCodexHost();
  const thread = host.add();
  thread.turns = turns(count);
  const client = new CodexClient(host.endpoint);
  const frames = [];
  client.on("frame", (frame) => frames.push(frame.payload));
  t.after(async () => {
    client.close();
    await host.close();
  });
  await client.connect();
  await client.list();
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    reply(socket, frame, historyPage(thread, frame));
    return true;
  };
  await client.history(thread.id, false);
  return { host, thread, client, frames, row: client.sessions.get(thread.id) };
}
async function revert(host, thread, client, remaining) {
  thread.turns = thread.turns.slice(0, remaining);
  // Wait for delivery even before the implementation understands this event.
  const received = new Promise((resolve) => {
    const listener = (frame) => {
      if (frame.method !== "thread/reverted") return;
      client.transport.off("message", listener);
      resolve();
    };
    client.transport.on("message", listener);
  });
  host.notify("thread/reverted", { threadId: thread.id });
  await received;
}

for (const notified of [true, false]) {
  for (const remaining of [1, 0]) {
    test(`${notified ? "notified" : "external"} revert to ${remaining} turns removes withdrawn history`, async (t) => {
      const { host, thread, client, frames, row } = await setup(t);
      if (notified) {
        await revert(host, thread, client, remaining);
        assert.equal(frames.at(-1)?.type, "session/history");
        assert.equal(frames.at(-1)?.reset, true);
        assert.deepEqual(frames.at(-1)?.events, []);
        assert.deepEqual(frames.at(-1)?.previousTurns, [
          JSON.stringify("saved-1"),
          JSON.stringify("saved-2"),
        ]);
      } else thread.turns = thread.turns.slice(0, remaining);
      const result = await client.history(thread.id, false);
      assert.deepEqual(
        ids(result),
        thread.turns.map((turn) => turn.id),
      );
      assert.equal(row.turns.size, remaining);
      assert.equal(result.hasMore, false);
    });
  }
}

for (const mode of ["recent", "older", "gap"]) {
  for (const replaced of [false, true]) {
    test(
      `a pre-revert ${mode} response is invalid even ${replaced ? "after" : "before"} replacement history loads`,
      { timeout: 5000 },
      async (t) => {
        const { host, thread, client, row } = await setup(t, 40);
        if (mode === "gap") thread.turns = turns(80);
        const waiting = Promise.withResolvers();
        let held = false;
        host.handler = (frame, socket) => {
          if (frame.method !== "thread/turns/list") return false;
          const result = structuredClone(historyPage(thread, frame));
          if (!held && (mode !== "gap" || frame.params.cursor)) {
            held = true;
            waiting.resolve(() => reply(socket, frame, result));
          } else reply(socket, frame, result);
          return true;
        };
        const pending = client.history(thread.id, mode === "older");
        pending.catch(() => {});
        const release = await waiting.promise;
        await revert(host, thread, client, 10);
        const expected = thread.turns.map((turn) => turn.id);
        if (replaced)
          assert.deepEqual(
            ids(await client.history(thread.id, false)),
            expected,
          );
        release();
        await assert.rejects(pending, /历史已更换/);
        if (!replaced) {
          // Invalidation is not proof of empty history. The caller must retry
          // without discarding the previous turn used for rollback detection.
          assert.equal(row.turns.size, 0);
          assert.equal(row.historyHead, undefined);
          assert.equal(row.cursor, undefined);
          assert.deepEqual(
            ids(await client.history(thread.id, false)),
            expected,
          );
        }
        assert.equal(row.historyHead, "saved-10");
        assert.equal(row.cursor, null);
        assert.equal(row.turns.size, 10);
      },
    );
  }
}

test(
  "reverting during a prompt confirmation blocks the stale write",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client, row } = await setup(t);
    const waiting = Promise.withResolvers();
    host.handler = (frame, socket) => {
      if (frame.method !== "thread/turns/list") return false;
      const result = structuredClone(historyPage(thread, frame));
      waiting.resolve(() => reply(socket, frame, result));
      return true;
    };
    const rejected = assert.rejects(
      client.rpc("session.prompt", {
        sessionId: thread.id,
        content: [{ type: "text", text: "continue" }],
      }),
      /历史已更换/,
    );
    const release = await waiting.promise;
    await revert(host, thread, client, 0);
    release();
    await rejected;
    assert.equal(row.currentTurnId, undefined);
    assert(
      !host.calls.some((call) =>
        ["turn/start", "turn/steer"].includes(call.method),
      ),
    );
  },
);

for (const notified of [true, false]) {
  test(`${notified ? "notified" : "external"} revert rebuilds pagination for the retained prefix`, async (t) => {
    const { host, thread, client, row } = await setup(t, 80);
    if (notified) await revert(host, thread, client, 35);
    else thread.turns = thread.turns.slice(0, 35);
    let result = await client.history(thread.id, false);
    if (notified) {
      assert.equal(result.hasMore, true);
      assert.equal(row.cursor, "saved-16");
      result = await client.history(thread.id, true);
    }
    assert.deepEqual(
      ids(result),
      thread.turns.map((turn) => turn.id),
    );
    assert.equal(row.turns.size, 35);
    assert.equal(result.hasMore, false);
  });
}

test("a failed replacement read keeps withdrawn content cleared and can be retried", async (t) => {
  const { host, thread, client, frames, row } = await setup(t);
  await revert(host, thread, client, 1);
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32000, message: "temporarily unavailable" },
      }),
    );
    return true;
  };
  await assert.rejects(
    client.history(thread.id, false),
    /temporarily unavailable/,
  );
  assert.deepEqual(row.order, []);
  assert.deepEqual(frames.at(-1).events, []);
  host.handler = null;
  assert.deepEqual(ids(await client.history(thread.id, false)), ["saved-1"]);
});

test(
  "a late start receipt cannot restore a turn that completed and was reverted",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client, row } = await setup(t);
    const waiting = Promise.withResolvers();
    host.handler = (frame, socket) => {
      if (frame.method !== "turn/start") return false;
      const turn = host.start(thread.id);
      const result = structuredClone({ turn });
      waiting.resolve({ turn, release: () => reply(socket, frame, result) });
      return true;
    };
    const sending = client.rpc("session.prompt", {
      sessionId: thread.id,
      content: [{ type: "text", text: "continue" }],
    });
    const { turn, release } = await waiting.promise;
    host.finish(thread.id, turn);
    await revert(host, thread, client, 2);
    release();
    await sending;
    assert(!row.turns.has(turn.id));
    assert.equal(row.currentTurnId, undefined);
    assert.deepEqual(ids(await client.history(thread.id, false)), [
      "saved-1",
      "saved-2",
    ]);
  },
);

test(
  "a full external refresh prunes reverted turns while preserving concurrent live work",
  { timeout: 5000 },
  async (t) => {
    const { host, thread, client, row } = await setup(t);
    thread.turns = thread.turns.slice(0, 1);
    const waiting = Promise.withResolvers();
    host.handler = (frame, socket) => {
      if (frame.method !== "thread/turns/list") return false;
      const result = structuredClone(historyPage(thread, frame));
      waiting.resolve(() => reply(socket, frame, result));
      return true;
    };
    const pending = client.history(thread.id, false);
    pending.catch(() => {});
    const release = await waiting.promise;
    const received = new Promise((resolve) => {
      const listener = (frame) => {
        if (frame.payload.event?.type !== "assistant/message") return;
        client.off("frame", listener);
        resolve();
      };
      client.on("frame", listener);
    });
    const fresh = host.start(thread.id);
    host.item(
      thread.id,
      fresh,
      { id: "new-reply", type: "agentMessage", text: "new live reply" },
      true,
    );
    await received;
    release();
    assert.deepEqual(ids(await pending), ["saved-1", fresh.id]);
    assert(!row.turns.has("saved-2"));
    assert.equal(row.currentTurnId, fresh.id);
  },
);
