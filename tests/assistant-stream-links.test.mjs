import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AssistantStreamLinks } from "../shared/assistant-stream-links.mjs";
import { DshClient } from "../shared/dsh-client.mjs";
import { projectSession } from "../shared/projection.mjs";
import {
  liveMessageId,
  reduceAssistantStream,
} from "../shared/assistant-stream.mjs";
import { createFixture } from "./fixture.mjs";

const final = (seq, turn = 1) => ({
  seq,
  type: "assistant/message",
  data: {
    turn,
    step: 0,
    message: { content: [{ type: "text", text: "Same reply" }] },
  },
});
const start = (links, sessionId = "s", attemptId = "attempt") =>
  links.observe({
    type: "session/assistant-stream",
    sessionId,
    frame: { type: "start", attemptId, revision: 1 },
  });
const receive = (links, event, sessionId = "s") =>
  links.observe({ type: "session/event", sessionId, event }).event;

test("stream starts carry their mux cursor, never an ahead-of-stream HTTP cursor", () => {
  const links = new AssistantStreamLinks();
  receive(links, { seq: 10, type: "step/start", data: { turn: 1, step: 0 } });
  links.history("s", [final(11), { seq: 12, type: "turn/end" }]);
  const payload = {
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "start",
      attemptId: "attempt",
      revision: 1,
      turn: 1,
      step: 0,
    },
  };
  const observed = links.observe(payload);
  assert.equal(observed.frame.afterSeq, 10);
  assert.equal(observed.frame.turn, 1);
  assert.equal(observed.frame.step, 0);
  assert.equal(payload.frame.afterSeq, undefined, "never mutate wire frames");
  assert.equal(
    start(links, "other").frame.afterSeq,
    undefined,
    "an unobserved socket cursor is not a durable history boundary",
  );
  receive(
    links,
    { seq: 0, type: "step/start", data: { turn: 1, step: 0 } },
    "other",
  );
  assert.equal(
    start(links, "other", "next").frame.afterSeq,
    0,
    "the first durable event is a valid cursor",
  );
});

for (const endFirst of [false, true])
  test(`DSH final events retain live identity across history refresh; end first = ${endFirst}`, () => {
    const links = new AssistantStreamLinks();
    const { frame } = start(links);
    if (endFirst)
      links.observe({
        type: "session/assistant-stream",
        sessionId: "s",
        frame: {
          type: "end",
          attemptId: "attempt",
          revision: 2,
          outcome: { kind: "committed" },
        },
      });
    const event = final(10);
    assert.equal(receive(links, event).data.attemptId, "attempt");
    assert.equal(event.data.attemptId, undefined, "never mutate host records");
    const [other, restored] = links.history("s", [final(1), event]);
    assert.equal(
      other.data.attemptId,
      undefined,
      "identical prose cannot steal the link",
    );
    assert.deepEqual(projectSession([restored]).messages[0].anchorIds, [
      liveMessageId(frame.attemptId, frame.streamId),
    ]);
    assert.equal(
      receive(links, final(11)).data.attemptId,
      undefined,
      "consume the association once",
    );
  });

test("history snapshots and replayed old events cannot consume a newer attempt", () => {
  const links = new AssistantStreamLinks();
  links.history("s", [final(5)]);
  receive(links, final(5));
  start(links);
  assert.equal(receive(links, final(5)).data.attemptId, undefined);
  // A read can see the current final before its notification is delivered.
  links.history("s", [final(6)]);
  assert.equal(receive(links, final(6)).data.attemptId, "attempt");
  start(links, "s", "next");
  assert.equal(receive(links, final(6)).data.attemptId, "attempt");
  assert.equal(receive(links, final(7)).data.attemptId, "next");
});

for (const aheadBy of [0, 1])
  test(`history ahead of stream start cannot suppress the final identity; ahead by ${aheadBy}`, () => {
    const links = new AssistantStreamLinks();
    receive(links, final(5));
    const event = final(6);
    const snapshot = [event];
    if (aheadBy) snapshot.push({ seq: 7, type: "turn/end", data: { turn: 1 } });
    assert.equal(links.history("s", snapshot)[0].data.attemptId, undefined);
    start(links);
    assert.equal(receive(links, final(5)).data.attemptId, undefined);
    assert.equal(receive(links, event).data.attemptId, "attempt");
    assert.equal(links.history("s", snapshot)[0].data.attemptId, "attempt");
    assert.equal(event.data.attemptId, undefined, "never mutate host records");
    assert.equal(receive(links, final(8)).data.attemptId, undefined);
  });

for (const boundary of [
  "cancel",
  "gap",
  "turn/start",
  "turn/end",
  "assistant/attempt",
  "reset",
  "remove",
  "disconnect",
])
  test(`DSH stream association is invalidated by ${boundary}`, () => {
    const links = new AssistantStreamLinks();
    start(links);
    if (boundary === "cancel" || boundary === "gap")
      links.observe({
        type: "session/assistant-stream",
        sessionId: "s",
        frame:
          boundary === "cancel"
            ? {
                type: "end",
                attemptId: "attempt",
                revision: 2,
                outcome: { kind: "cancelled" },
              }
            : { type: "chunk", attemptId: "attempt", revision: 4 },
      });
    else if (boundary === "disconnect") links.reset();
    else if (boundary === "reset" || boundary === "remove")
      links.observe({
        type: boundary === "reset" ? "session/history" : "host/session-removed",
        sessionId: "s",
        reset: true,
      });
    else receive(links, { seq: 1, type: boundary, data: {} });
    assert.equal(receive(links, final(10)).data.attemptId, undefined);
  });

test("links are scoped by session and lifetime, and explicit host identities win", () => {
  const links = new AssistantStreamLinks();
  start(links);
  assert.equal(receive(links, final(1), "other").data.attemptId, undefined);
  const event = final(1);
  event.data.attemptId = "host-attempt";
  assert.equal(receive(links, event).data.attemptId, "host-attempt");
  assert.equal(
    links.history("s", [final(1)])[0].data.attemptId,
    "host-attempt",
  );
  links.reset();
  assert.equal(links.history("s", [final(1)])[0].data.attemptId, undefined);
  start(links, "s", "new-connection");
  assert.equal(receive(links, final(2)).data.attemptId, "new-connection");
});

test("duplicate start/end notifications cannot bind the completed attempt to a later reply", () => {
  const links = new AssistantStreamLinks();
  start(links);
  receive(links, final(1));
  start(links);
  links.observe({
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "end",
      attemptId: "attempt",
      revision: 2,
      outcome: { kind: "committed" },
    },
  });
  assert.equal(receive(links, final(2)).data.attemptId, undefined);
});

test("DSH stream identities remain stable within an attempt and change across resets", () => {
  const links = new AssistantStreamLinks();
  const first = start(links).frame;
  const duplicate = start(links).frame;
  assert.equal(duplicate.streamId, first.streamId);
  const chunk = links.observe({
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "chunk",
      attemptId: "attempt",
      revision: 2,
      chunk: { type: "text-delta", text: "Old" },
    },
  }).frame;
  assert.equal(chunk.streamId, first.streamId);
  const old = receive(links, final(1));
  assert.equal(old.data.streamId, first.streamId);
  assert.equal(links.history("s", [final(1)])[0].data.streamId, first.streamId);
  links.reset();
  const next = start(links).frame;
  assert.notEqual(next.streamId, first.streamId);
  const stream = reduceAssistantStream(
    reduceAssistantStream(null, first),
    next,
  );
  assert.equal(
    stream.streamId,
    next.streamId,
    "a restarted revision must replace the old lifecycle",
  );
  assert.equal(
    reduceAssistantStream(stream, chunk),
    stream,
    "late old chunks cannot enter a reused attempt",
  );
  assert.equal(
    reduceAssistantStream(stream, { ...chunk, type: "end" }),
    stream,
    "late old endings cannot clear a reused attempt",
  );
});

test("a reused host attempt in another turn gets a fresh identity without a transport reset", () => {
  const links = new AssistantStreamLinks();
  const stream = (turn) =>
    links.observe({
      type: "session/assistant-stream",
      sessionId: "s",
      frame: {
        type: "start",
        attemptId: "attempt",
        revision: 1,
        turn,
        step: turn,
      },
    }).frame;
  const first = stream(1);
  receive(links, { ...final(1), data: { ...final(1).data, step: 1 } });
  receive(links, { seq: 2, type: "turn/start", data: { turn: 2 } });
  const next = stream(2);
  assert.notEqual(next.streamId, first.streamId);
  const finalEvent = final(3, 2);
  finalEvent.data.step = 2;
  finalEvent.data.attemptId = "attempt";
  assert.equal(receive(links, finalEvent).data.streamId, next.streamId);
  assert.equal(
    finalEvent.data.streamId,
    undefined,
    "host records stay immutable",
  );
});

for (const historyFirst of [false, true])
  test(`DshClient enriches real mux notifications and HTTP history; history first = ${historyFirst}`, async (t) => {
    const fixture = await createFixture();
    const event = final(0);
    fixture.sessions.set("s", {
      sessionId: "s",
      events: [event],
      running: true,
    });
    const client = new DshClient(fixture.endpoint);
    t.after(async () => {
      client.close();
      await fixture.close();
    });
    const connected = new Promise((resolve) =>
      client.on("stream", () => {
        if (client.streams.size === 2) resolve();
      }),
    );
    await client.connect();
    await connected;
    if (historyFirst) {
      const history = await client.rpc("session.history", { sessionId: "s" });
      assert.equal(history.events[0].event.data.attemptId, undefined);
    }
    const began = once(client, "frame");
    fixture.push("mux", {
      type: "session/assistant-stream",
      sessionId: "s",
      frame: { type: "start", attemptId: "wire-attempt", revision: 1 },
    });
    const started = (await began)[0].payload.frame;
    const completed = once(client, "frame");
    fixture.push("mux", { type: "session/event", sessionId: "s", event });
    const received = (await completed)[0].payload.event;
    assert.equal(received.data.attemptId, "wire-attempt");
    assert.equal(received.data.streamId, started.streamId);
    assert.equal(typeof started.streamId, "string");
    const history = await client.rpc("session.history", { sessionId: "s" });
    assert.equal(history.events[0].event.data.attemptId, "wire-attempt");
    assert.equal(history.events[0].event.data.streamId, started.streamId);
    assert.equal(fixture.sessions.get("s").events[0].data.attemptId, undefined);
  });

test("a late HTTP history response cannot seed identities in a replacement connection", async (t) => {
  const client = new DshClient("http://127.0.0.1:3080");
  t.after(() => client.close());
  let reply;
  client.request = async (_path, options) =>
    new Promise((resolve) => {
      const { rpcId } = JSON.parse(options.body);
      reply = () =>
        resolve({
          type: "server-response",
          rpcId,
          result: {
            ok: true,
            value: { events: [{ event: final(100) }], hasMore: false },
          },
        });
    });
  const pending = client.rpc("session.history", { sessionId: "s" });
  client.assistantLinks.reset();
  start(client.assistantLinks, "s", "replacement");
  receive(client.assistantLinks, final(100));
  reply();
  assert.equal(
    (await pending).events[0].event.data.attemptId,
    undefined,
    "old HTTP records must not inherit the replacement connection's identity",
  );
  assert.equal(
    client.assistantLinks.history("s", [final(100)])[0].data.attemptId,
    "replacement",
  );
});
