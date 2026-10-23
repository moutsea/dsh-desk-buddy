import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../shared/codex-client.mjs";
import { compareCodexTurns } from "../shared/codex-turn-order.mjs";
import { latestTurn, turnState } from "../shared/turn-state.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";

const uuid = (ms, suffix = "000000000000") => {
  const stamp = ms.toString(16).padStart(12, "0");
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-${suffix}`;
};
const saved = (id, startedAt) => ({
  id,
  status: "completed",
  items: [],
  ...(startedAt === undefined ? {} : { startedAt }),
});

test("Codex order uses source time and UUIDv7 milliseconds, never opaque IDs or equal-time random bits", () => {
  assert.equal(compareCodexTurns(saved(uuid(1001)), saved(uuid(1000))), 1);
  assert.equal(compareCodexTurns(saved(uuid(1000)), saved(uuid(1001))), -1);
  assert.equal(
    compareCodexTurns(saved("opaque-a", 3), saved("opaque-z", 2)),
    1,
  );
  assert.equal(
    compareCodexTurns(saved("opaque-a", 1), saved("opaque-z", 2)),
    -1,
  );
  assert.equal(compareCodexTurns(saved("same"), saved("same")), 0);
  for (const time of [undefined, null, NaN, -1, 2])
    assert.equal(
      compareCodexTurns(saved("old-999", time), saved("old-1", time)),
      undefined,
    );
  assert.equal(
    compareCodexTurns(saved(uuid(1000, "ffffffffffff")), saved(uuid(1000))),
    undefined,
  );
});

test("turn chronology survives completion and history projection without leaking into the next turn", () => {
  const start = {
    seq: 1,
    type: "turn/start",
    data: { turn: "a", startedAt: 123 },
  };
  const end = {
    seq: 2,
    type: "turn/end",
    data: { turn: "a", reason: "completed" },
  };
  assert.deepEqual(latestTurn([start, end]), {
    key: '"a"',
    startedAt: 123,
    status: "done",
  });
  assert.deepEqual(
    turnState(
      { seq: 3, type: "turn/start", data: { turn: "b" } },
      latestTurn([start, end]),
    ),
    { key: '"b"', status: "thinking" },
  );
});

async function setup(t, turns) {
  const host = await createCodexHost(),
    thread = host.add();
  thread.turns = turns;
  const client = new CodexClient(host.endpoint);
  t.after(async () => {
    client.close();
    await host.close();
  });
  await client.connect();
  await client.list();
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    const ordered = [...thread.turns].reverse();
    const offset = frame.params.cursor
      ? ordered.findIndex((turn) => turn.id === frame.params.cursor) + 1
      : 0;
    const data = ordered.slice(offset, offset + frame.params.limit);
    socket.send(
      JSON.stringify({
        id: frame.id,
        result: {
          data,
          nextCursor:
            offset + data.length < ordered.length ? data.at(-1).id : null,
        },
      }),
    );
    return true;
  };
  const read = (previous) =>
    client.history(
      thread.id,
      false,
      previous && {
        key: JSON.stringify(previous.id),
        startedAt: previous.startedAt,
      },
    );
  return { host, thread, client, read };
}

for (const clock of ["uuid", "timestamp", "legacy"]) {
  test(`${clock} history recognizes an uncached earlier head after a cross-page revert`, async (t) => {
    const turns = Array.from({ length: 45 }, (_, i) =>
      clock === "uuid"
        ? saved(uuid(1000 + i))
        : saved(`old-${i}`, clock === "timestamp" ? i : undefined),
    );
    const { thread, client, read } = await setup(t, turns);
    const initial = await read();
    assert.equal(
      initial.events.filter(({ event }) => event.type === "turn/start").length,
      20,
    );
    thread.turns = turns.slice(0, 5);
    // No notification: this also exercises external/offline rollback detection.
    const result = await read(turns.at(-1));
    assert.equal(result.historical, true);
    assert.equal(latestTurn(result.events).key, JSON.stringify(turns[4].id));
    assert(!client.sessions.get(thread.id).turns.has(turns.at(-1).id));
  });
}

test("legacy and equal-time unseen work is proven by a previous head beyond the first page", async (t) => {
  const turns = Array.from({ length: 65 }, (_, i) => saved(`turn-${i}`, 123));
  const { read, host } = await setup(t, turns);
  const result = await read(turns[4]);
  assert.equal(result.historical, undefined);
  assert.equal(latestTurn(result.events).key, JSON.stringify(turns.at(-1).id));
  assert.equal(
    host.calls.filter((c) => c.method === "thread/turns/list").length,
    4,
  );
});

test("a verified timestamp identifies new work even when offline rollback removed the old anchor", async (t) => {
  const { read, host } = await setup(t, [
    saved("ancient", 1),
    saved("after-rollback", 30),
  ]);
  const result = await read(saved("removed", 20));
  assert.equal(result.historical, undefined);
  assert.equal(latestTurn(result.events).startedAt, 30);
  assert.equal(
    host.calls.filter((c) => c.method === "thread/turns/list").length,
    1,
  );
});

test("an unavailable ancestor page stays unknown and can be retried without publishing a partial head", async (t) => {
  const turns = Array.from({ length: 45 }, (_, i) => saved(`turn-${i}`));
  const { read, host, client, thread } = await setup(t, turns);
  const serve = host.handler;
  host.handler = (frame, socket) => {
    if (frame.method === "thread/turns/list" && frame.params.cursor) {
      socket.send(
        JSON.stringify({
          id: frame.id,
          error: { code: -32000, message: "old page unavailable" },
        }),
      );
      return true;
    }
    return serve(frame, socket);
  };
  await assert.rejects(read(turns[0]), /old page unavailable/);
  assert.equal(client.sessions.get(thread.id).turns.size, 0);
  host.handler = serve;
  assert.equal((await read(turns[0])).historical, undefined);
});
