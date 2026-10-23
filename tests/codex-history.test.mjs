import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../shared/codex-client.mjs";
import { CodexSession } from "../shared/codex-session.mjs";
import { projectSession } from "../shared/projection.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";

const turn = (id, text, status = "completed") => ({
  id,
  status,
  items: [{ id: `${id}-message`, type: "agentMessage", text }],
});
const messages = (result) =>
  projectSession(result.events.map(({ event }) => event)).messages.map(
    (message) => message.text,
  );
const page = (socket, frame, data, nextCursor = null) =>
  socket.send(JSON.stringify({ id: frame.id, result: { data, nextCursor } }));

async function setup(t, readOnly = false) {
  const host = await createCodexHost();
  const thread = host.add();
  if (readOnly) thread.status = { type: "notLoaded" };
  const client = new CodexClient(host.endpoint);
  t.after(async () => {
    client.close();
    await host.close();
  });
  await client.connect();
  await client.list();
  return { host, thread, client, row: client.sessions.get(thread.id) };
}

const numberedTurns = (count) =>
  Array.from({ length: count }, (_, i) => turn(`t-${i + 1}`, `reply-${i + 1}`));
const historyIds = (result) =>
  result.events
    .filter(({ event }) => event.type === "turn/start")
    .map(({ event }) => event.data.turn);
function paginatedHistory(thread, frame) {
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
function serveHistory(thread, frame, socket) {
  if (frame.method !== "thread/turns/list") return false;
  const result = paginatedHistory(thread, frame);
  socket.send(JSON.stringify({ id: frame.id, result }));
  return true;
}

for (const initial of [0, 1, 25]) {
  test(`refresh after ${initial} saved turns joins a multi-page gap without losing older pagination`, async (t) => {
    const { host, thread, client, row } = await setup(t, true);
    thread.turns = numberedTurns(initial);
    host.handler = (frame, socket) => serveHistory(thread, frame, socket);
    await client.history(thread.id, false);
    const oldestCursor = row.cursor;
    thread.turns = numberedTurns(initial + 70);
    let result = await client.history(thread.id, false);
    if (initial) {
      assert.equal(row.cursor, oldestCursor, "keep the loaded oldest boundary");
      assert.deepEqual(
        historyIds(result),
        thread.turns.slice(Math.max(0, initial - 20)).map((turn) => turn.id),
        "join the missing middle before publishing the refreshed window",
      );
    } else {
      assert.equal(
        result.hasMore,
        true,
        "an initially empty chat can gain older pages",
      );
    }
    for (let reads = 0; result.hasMore && reads < 10; reads++)
      result = await client.history(thread.id, true);
    assert.equal(result.hasMore, false);
    assert.deepEqual(
      historyIds(result),
      thread.turns.map((turn) => turn.id),
    );
  });
}

test("an overlapping refresh keeps already loaded older pages and uses one RPC", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  thread.turns = numberedTurns(65);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  await client.history(thread.id, false);
  await client.history(thread.id, true);
  const cursor = row.cursor;
  const before = host.calls.filter(
    (call) => call.method === "thread/turns/list",
  ).length;
  thread.turns = numberedTurns(70);
  const result = await client.history(thread.id, false);
  assert.equal(
    host.calls.filter((call) => call.method === "thread/turns/list").length -
      before,
    1,
  );
  assert.equal(row.cursor, cursor);
  assert.deepEqual(
    historyIds(result),
    thread.turns.slice(25).map((turn) => turn.id),
  );
});

test("a failed gap read preserves the committed cache and can be retried", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  thread.turns = numberedTurns(1);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  await client.history(thread.id, false);
  thread.turns = numberedTurns(71);
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (frame.params.cursor) {
      socket.send(
        JSON.stringify({
          id: frame.id,
          error: { code: -32000, message: "gap unavailable" },
        }),
      );
      return true;
    }
    return serveHistory(thread, frame, socket);
  };
  await assert.rejects(client.history(thread.id, false), /gap unavailable/);
  assert.deepEqual(row.order, ["t-1"]);
  assert.equal(row.cursor, null);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  const result = await client.history(thread.id, false);
  assert.deepEqual(
    historyIds(result),
    thread.turns.map((turn) => turn.id),
  );
});

test("gap reads join the saved head despite live overlap and preserve concurrent pagination and completion", async (t) => {
  const { host, thread, client, row } = await setup(t);
  thread.turns = numberedTurns(35);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  await client.history(thread.id, false);
  thread.turns = numberedTurns(75);
  const live = thread.turns.at(-1);
  live.status = "inProgress";
  // Seeing the newest turn live does not fill the unseen historical middle.
  row.updateTurn(live, true);
  const waiting = Promise.withResolvers();
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (frame.params.cursor === "t-56") {
      const result = paginatedHistory(thread, frame);
      waiting.resolve(() =>
        socket.send(JSON.stringify({ id: frame.id, result })),
      );
      return true;
    }
    return serveHistory(thread, frame, socket);
  };
  const pending = client.history(thread.id, false);
  const release = await waiting.promise;
  await client.history(thread.id, true);
  assert.equal(row.cursor, null);
  const completed = Promise.withResolvers();
  client.on("frame", (frame) => {
    if (frame.payload.event?.type === "turn/end") completed.resolve();
  });
  host.item(
    thread.id,
    live,
    { ...live.items[0], text: "fresh completion" },
    true,
  );
  host.finish(thread.id, live);
  await completed.promise;
  release();
  const result = await pending;
  assert.deepEqual(
    historyIds(result),
    thread.turns.map((turn) => turn.id),
  );
  assert.equal(messages(result).at(-1), "fresh completion");
  assert.equal(row.activeTurn, undefined);
  assert.equal(
    row.cursor,
    null,
    "do not rewind the concurrently advanced cursor",
  );
});

test("a superseded gap read stops fetching and returns the newer complete window", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  thread.turns = numberedTurns(1);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  await client.history(thread.id, false);
  thread.turns = numberedTurns(71);
  const waiting = Promise.withResolvers();
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (frame.params.cursor === "t-52") {
      const result = paginatedHistory(thread, frame);
      waiting.resolve(() =>
        socket.send(JSON.stringify({ id: frame.id, result })),
      );
      return true;
    }
    return serveHistory(thread, frame, socket);
  };
  const pending = client.history(thread.id, false);
  const release = await waiting.promise;
  thread.turns = numberedTurns(101);
  await client.history(thread.id, false);
  const calls = host.calls.length;
  release();
  const result = await pending;
  assert.equal(
    host.calls.length,
    calls,
    "the superseded reader must not fetch another page",
  );
  assert.deepEqual(
    historyIds(result),
    thread.turns.map((turn) => turn.id),
  );
  assert.equal(row.cursor, null);
});

test("a repeated gap cursor fails without looping or committing an incomplete window", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  thread.turns = numberedTurns(1);
  host.handler = (frame, socket) => serveHistory(thread, frame, socket);
  await client.history(thread.id, false);
  thread.turns = numberedTurns(71);
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    const result = paginatedHistory(thread, frame);
    if (frame.params.cursor) result.nextCursor = frame.params.cursor;
    socket.send(JSON.stringify({ id: frame.id, result }));
    return true;
  };
  await assert.rejects(client.history(thread.id, false), /分页未前进/);
  assert.deepEqual(row.order, ["t-1"]);
  assert.equal(row.cursor, null);
});

test("initial history precedes a live turn first seen while the read is pending", async (t) => {
  const { host, thread, client, row } = await setup(t);
  const waiting = Promise.withResolvers();
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    waiting.resolve(() => page(socket, frame, [turn("old", "old reply")]));
    return true;
  };
  const pending = client.history(thread.id, false);
  const release = await waiting.promise;
  const received = Promise.withResolvers();
  client.on("frame", (frame) => {
    if (frame.payload.event?.type === "assistant/message") received.resolve();
  });
  const fresh = host.start(thread.id);
  host.item(thread.id, fresh, turn("new", "new reply").items[0], true);
  await received.promise;
  release();
  const result = await pending;
  assert.deepEqual(messages(result), ["old reply", "new reply"]);
  assert.deepEqual(row.order, ["old", fresh.id]);
  assert.equal(row.activeTurn, fresh.id);
});

test("late history cannot replace fresher text, terminal status or the initial cursor", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  const waiting = Promise.withResolvers();
  let reads = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (++reads === 1)
      waiting.resolve(() =>
        page(socket, frame, [turn("t", "partial", "inProgress")], "stale"),
      );
    else page(socket, frame, [turn("t", "complete")], "current");
    return true;
  };
  const first = client.history(thread.id, false);
  const release = await waiting.promise;
  assert.deepEqual(messages(await client.history(thread.id, false)), [
    "complete",
  ]);
  release();
  assert.deepEqual(messages(await first), ["complete"]);
  assert.equal(row.activeTurn, undefined);
  assert.equal(row.cursor, "current");
});

test("a superseded recent page cannot reorder or reintroduce its older window", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  const waiting = Promise.withResolvers();
  let reads = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (++reads === 1)
      waiting.resolve(() =>
        page(socket, frame, [turn("a", "old window")], "old"),
      );
    else page(socket, frame, [turn("b", "new window")], "older-page");
    return true;
  };
  const first = client.history(thread.id, false);
  const release = await waiting.promise;
  await client.history(thread.id, false);
  release();
  assert.deepEqual(messages(await first), ["new window"]);
  assert.deepEqual(row.order, ["b"]);
  assert.equal(row.cursor, "older-page");
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    assert.equal(frame.params.cursor, "older-page");
    page(socket, frame, [turn("a", "old window")]);
    return true;
  };
  assert.deepEqual(messages(await client.history(thread.id, true)), [
    "old window",
    "new window",
  ]);
});

test("a newer failed read does not discard an earlier successful response", async (t) => {
  const { host, thread, client } = await setup(t, true);
  const waiting = Promise.withResolvers();
  let reads = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (++reads === 1)
      waiting.resolve(() => page(socket, frame, [turn("a", "saved reply")]));
    else
      socket.send(
        JSON.stringify({
          id: frame.id,
          error: { code: -32000, message: "temporary failure" },
        }),
      );
    return true;
  };
  const first = client.history(thread.id, false);
  const release = await waiting.promise;
  await assert.rejects(client.history(thread.id, false), /temporary failure/);
  release();
  assert.deepEqual(messages(await first), ["saved reply"]);
});

test("overlapping older reads cannot rewind the cursor or overwrite the loaded page", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  const waiting = Promise.withResolvers();
  let olderReads = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (!frame.params.cursor)
      page(socket, frame, [turn("b", "latest")], "older");
    else if (++olderReads === 1)
      waiting.resolve(() =>
        page(socket, frame, [turn("a", "stale older reply")], "stale-cursor"),
      );
    else page(socket, frame, [turn("a", "saved older reply")], "oldest");
    return true;
  };
  await client.history(thread.id, false);
  const first = client.history(thread.id, true);
  const release = await waiting.promise;
  await client.history(thread.id, true);
  release();
  assert.deepEqual(messages(await first), ["saved older reply", "latest"]);
  assert.equal(row.cursor, "oldest");
});

test("older-page merging retains missing history without overwriting a newer recent read", () => {
  const row = new CodexSession({ id: "s" });
  row.mergePage([turn("b", "partial", "inProgress")], 1);
  row.mergePage([turn("b", "complete")], 3);
  // A full-history compatibility response can overlap the latest page.
  row.mergePage(
    [turn("a", "older"), turn("b", "stale", "inProgress")],
    2,
    true,
  );
  assert.deepEqual(row.order, ["a", "b"]);
  assert.equal(row.activeTurn, undefined);
  assert.deepEqual(
    projectSession(row.events()).messages.map((m) => m.text),
    ["older", "complete"],
  );
});

test("a disjoint recent page fits between loaded history and a new live turn", () => {
  const row = new CodexSession({ id: "s" });
  row.mergePage([turn("a", "older")], 0);
  const revision = row.revision;
  row.updateTurn(turn("c", "new live", "inProgress"), true);
  row.mergePage([turn("b", "recent")], revision);
  assert.deepEqual(row.order, ["a", "b", "c"]);
  assert.equal(row.activeTurn, "c");
});

test("an item arriving before its turn notification still follows pending history", () => {
  const row = new CodexSession({ id: "s" });
  const revision = row.revision;
  row.updateItem("new", turn("new", "new reply").items[0]);
  row.mergePage([turn("old", "old reply")], revision);
  assert.deepEqual(row.order, ["old", "new"]);
  assert.equal(row.activeTurn, "new");
});

test("older pagination can finish after a recent refresh without replacing its newer content", async (t) => {
  const { host, thread, client, row } = await setup(t, true);
  const waiting = Promise.withResolvers();
  let recentReads = 0;
  host.handler = (frame, socket) => {
    if (frame.method !== "thread/turns/list") return false;
    if (frame.params.cursor)
      waiting.resolve(() =>
        page(socket, frame, [
          turn("b", "partial", "inProgress"),
          turn("a", "old reply"),
        ]),
      );
    else
      page(
        socket,
        frame,
        [turn("b", ++recentReads === 1 ? "partial" : "complete")],
        "older",
      );
    return true;
  };
  await client.history(thread.id, false);
  const pending = client.history(thread.id, true);
  const release = await waiting.promise;
  await client.history(thread.id, false);
  release();
  assert.deepEqual(messages(await pending), ["old reply", "complete"]);
  assert.equal(row.activeTurn, undefined);
  assert.equal(row.cursor, null);
});
