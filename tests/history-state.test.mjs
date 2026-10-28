import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HISTORY_EVENTS,
  setAssistantStream,
  setHistoryEvents,
} from "../electron/history-state.mjs";
import { mergeEvents, projectSession } from "../shared/projection.mjs";
import {
  liveMessageId,
  reduceAssistantStream,
} from "../shared/assistant-stream.mjs";
import { AssistantStreamLinks } from "../shared/assistant-stream-links.mjs";

const empty = () => ({ events: [], eventsRevision: 0, hasMore: false });
const events = (count) =>
  Array.from({ length: count }, (_, seq) => ({ seq, type: "tool/call" }));

test("live snapshots cannot reopen pagination after a history page reaches the limit", () => {
  const state = empty();
  setHistoryEvents(state, events(MAX_HISTORY_EVENTS - 1), true);
  assert.equal(state.hasMore, true);
  setHistoryEvents(state, events(MAX_HISTORY_EVENTS), true);
  assert.equal(state.hasMore, false);
  // Codex's cursor still points to older turns in each subsequent snapshot.
  for (const count of [MAX_HISTORY_EVENTS, MAX_HISTORY_EVENTS + 1]) {
    setHistoryEvents(state, events(count), true);
    assert.equal(state.hasMore, false);
    assert.equal(state.events.length, count, "never drop received history");
  }
  assert.equal(state.eventsRevision, 4);
});

test("live appends close pagination at the limit without losing new or old events", () => {
  const state = empty();
  setHistoryEvents(state, events(MAX_HISTORY_EVENTS - 1), true);
  const incoming = [
    { seq: MAX_HISTORY_EVENTS - 1, type: "assistant/message" },
    { seq: MAX_HISTORY_EVENTS, type: "turn/end" },
  ];
  for (const event of incoming) {
    setHistoryEvents(state, mergeEvents(state.events, [event]));
    assert.equal(state.hasMore, false);
    assert.deepEqual(state.events.at(-1), event);
    assert.equal(state.events[0].seq, 0);
  }
});

test("a smaller replacement or another session can page again when the host has more", () => {
  const state = empty();
  setHistoryEvents(state, events(MAX_HISTORY_EVENTS), true);
  setHistoryEvents(state, [], false);
  assert.equal(state.hasMore, false);
  setHistoryEvents(state, events(20), true);
  assert.equal(state.hasMore, true);
  setHistoryEvents(state, events(40), false);
  assert.equal(state.hasMore, false, "an exhausted host cursor stays closed");
});

const final = (seq = 11, data = {}) => ({
  seq,
  type: "assistant/message",
  data: {
    turn: 1,
    step: 0,
    message: { content: [{ type: "text", text: "Same reply" }] },
    ...data,
  },
});
const streaming = () => {
  const links = new AssistantStreamLinks();
  links.observe({
    type: "session/event",
    sessionId: "s",
    event: { seq: 10, type: "step/start", data: { turn: 1, step: 0 } },
  });
  const { frame } = links.observe({
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "start",
      attemptId: "attempt",
      revision: 1,
      turn: 1,
      step: 0,
    },
  });
  const chunk = links.observe({
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "chunk",
      attemptId: "attempt",
      revision: 2,
      chunk: { type: "text-delta", text: "Same reply" },
    },
  }).frame;
  const live = reduceAssistantStream(reduceAssistantStream(null, frame), chunk);
  return {
    links,
    frame,
    state: { ...empty(), selectedId: "s", liveAssistant: { s: live } },
  };
};

test("HTTP final replaces the selected stream before its mux notification", () => {
  const { links, state } = streaming();
  const raw = final();
  setHistoryEvents(state, links.history("s", [raw]), true);
  assert.equal(state.liveAssistant.s, null);
  assert.equal(state.events[0].data.attemptId, "attempt");
  assert.equal(raw.data.attemptId, undefined, "host records stay immutable");
  assert.equal(state.eventsRevision, 1);
  assert.equal(state.hasMore, true);
});

test("an explicit final identity also reconciles streams without DSH cursors", () => {
  const state = {
    ...empty(),
    selectedId: "s",
    liveAssistant: {
      s: { attemptId: "codex-attempt", revision: 2, text: "Same reply" },
    },
  };
  setHistoryEvents(state, [final(11, { attemptId: "codex-attempt" })]);
  assert.equal(state.liveAssistant.s, null);
});

test("a repeated raw HTTP snapshot preserves an already confirmed live alias", () => {
  const raw = final();
  const merged = mergeEvents([final(11, { attemptId: "attempt" })], [raw]);
  assert.equal(merged[0].data.attemptId, "attempt");
  assert.equal(raw.data.attemptId, undefined);
});

test("a rendered HTTP final before stream start suppresses all delayed chunks", () => {
  const { state, frame } = streaming();
  state.liveAssistant.s = null;
  setHistoryEvents(state, [final()]);
  setAssistantStream(state, "s", frame);
  assert.equal(state.liveAssistant.s, null);
  assert.equal(state.events[0].data.attemptId, "attempt");
  assert.equal(state.eventsRevision, 2, "publish the new anchor identity");
  for (const revision of [2, 3]) {
    setAssistantStream(state, "s", {
      type: "chunk",
      attemptId: "attempt",
      revision,
      chunk: { type: "text-delta", text: "Late output" },
    });
    assert.equal(state.liveAssistant.s, null);
  }
  // A duplicate start keeps the original scope and sees the durable identity.
  setAssistantStream(state, "s", frame);
  assert.equal(state.liveAssistant.s, null);
  assert.equal(state.eventsRevision, 2);
});

test("late stream frames and repeated HTTP reads cannot undo a snapshot replacement", () => {
  const { links, state } = streaming();
  const raw = final();
  setHistoryEvents(state, links.history("s", [raw]));
  setAssistantStream(state, "s", {
    type: "chunk",
    attemptId: "attempt",
    revision: 3,
    chunk: { type: "text-delta", text: "Late output" },
  });
  setHistoryEvents(state, mergeEvents(state.events, links.history("s", [raw])));
  const mux = links.observe({
    type: "session/event",
    sessionId: "s",
    event: raw,
  }).event;
  setHistoryEvents(state, mergeEvents(state.events, [mux]));
  setAssistantStream(state, "s", {
    type: "end",
    attemptId: "attempt",
    revision: 4,
    outcome: { kind: "committed" },
  });
  assert.equal(state.liveAssistant.s, null);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].data.attemptId, "attempt");
});

for (const [name, incoming] of [
  ["older identical reply", [final(9)]],
  ["another turn", [final(11, { turn: 2 })]],
  ["another step", [final(11, { step: 1 })]],
  ["explicit different attempt", [final(11, { attemptId: "other" })]],
  ["reused ID from an older sequence", [final(9, { attemptId: "attempt" })]],
  [
    "reused ID from another turn",
    [final(11, { attemptId: "attempt", turn: 2 })],
  ],
  [
    "reused ID from another step",
    [final(11, { attemptId: "attempt", step: 1 })],
  ],
  ["replacement", [{ ...final(), surfaceOp: "replace" }]],
  ["hidden replacement", [{ ...final(), surfaceOp: { kind: "replace" } }]],
])
  test(`HTTP history does not steal the current stream for ${name}`, () => {
    const { state } = streaming();
    const live = state.liveAssistant.s;
    setHistoryEvents(state, incoming);
    assert.equal(state.liveAssistant.s, live);
    assert.equal(state.events, incoming);
  });

for (const type of ["assistant/attempt", "turn/start", "turn/end"])
  test(`HTTP ${type} retires the old stream without binding the subsequent reply`, () => {
    const { state, links, frame } = streaming();
    const incoming = [
      { seq: 11, type, data: { turn: type === "turn/start" ? 2 : 1, step: 0 } },
      final(12),
    ];
    setHistoryEvents(state, links.history("s", incoming));
    assert.equal(state.liveAssistant.s, null);
    assert.deepEqual(
      state.events,
      incoming,
      "never lend the retired stream's identity to a retry",
    );
    setAssistantStream(state, "s", frame);
    setAssistantStream(
      state,
      "s",
      links.observe({
        type: "session/assistant-stream",
        sessionId: "s",
        frame: {
          type: "chunk",
          attemptId: "attempt",
          revision: 3,
          chunk: { type: "text-delta", text: "late failed draft" },
        },
      }).frame,
    );
    assert.equal(
      state.liveAssistant.s,
      null,
      "delayed frames cannot resurrect a durable failure",
    );
  });

test("failure snapshots only retire the matching stream boundary", () => {
  for (const boundary of [
    { seq: 9, type: "assistant/attempt", data: { turn: 1, step: 0 } },
    { seq: 11, type: "assistant/attempt", data: { turn: 2, step: 0 } },
    { seq: 11, type: "assistant/attempt", data: { turn: 1, step: 1 } },
    {
      seq: 11,
      type: "assistant/attempt",
      data: { turn: 1, step: 0, attemptId: "other" },
    },
    {
      seq: 11,
      type: "assistant/attempt",
      data: { turn: 1, step: 0, streamId: "other" },
    },
    { seq: 11, type: "turn/end", data: { turn: 2 } },
  ]) {
    const { state } = streaming();
    const live = state.liveAssistant.s;
    const incoming =
      boundary.seq < live.afterSeq ? [boundary] : [boundary, final(12)];
    setHistoryEvents(state, incoming);
    assert.equal(state.liveAssistant.s, live);
    assert.deepEqual(state.events, incoming);
  }
});

test("the actual retry receives its own alias after HTTP has retired the failed attempt", () => {
  const { state, links } = streaming();
  const failedId = state.liveAssistant.s.streamId;
  const failure = {
    seq: 11,
    type: "assistant/attempt",
    data: { turn: 1, step: 0 },
  };
  setHistoryEvents(state, links.history("s", [failure, final(12)]));
  assert.equal(state.liveAssistant.s, null);
  links.observe({ type: "session/event", sessionId: "s", event: failure });
  const { frame } = links.observe({
    type: "session/assistant-stream",
    sessionId: "s",
    frame: {
      type: "start",
      attemptId: "retry",
      revision: 5,
      turn: 1,
      step: 0,
    },
  });
  setAssistantStream(state, "s", frame);
  assert.equal(state.liveAssistant.s, null, "the retry is already durable too");
  assert.equal(state.events[1].data.attemptId, "retry");
  assert.equal(state.events[1].data.streamId, frame.streamId);
  assert.notEqual(state.events[1].data.streamId, failedId);
});

for (const reconnect of [false, true])
  for (const historyFirst of [false, true])
    test(`unknown stream cursors cannot consume existing history; reconnect = ${reconnect}, history first = ${historyFirst}`, () => {
      for (const boundary of [
        { seq: 10, type: "turn/start", data: { turn: 1 } },
        { seq: 10, type: "turn/start", data: { turn: 0 } },
        { seq: 10, type: "turn/end", data: { turn: 1 } },
        { seq: 10, type: "assistant/attempt", data: { turn: 1, step: 0 } },
        final(10),
        final(10, { attemptId: "attempt" }),
      ]) {
        const links = new AssistantStreamLinks();
        const state = { ...empty(), selectedId: "s", liveAssistant: {} };
        if (reconnect) {
          links.observe({
            type: "session/event",
            sessionId: "s",
            event: boundary,
          });
          links.reset();
        }
        const snapshot = () =>
          setHistoryEvents(state, links.history("s", [boundary]));
        const stream = (frame) =>
          setAssistantStream(
            state,
            "s",
            links.observe({
              type: "session/assistant-stream",
              sessionId: "s",
              frame,
            }).frame,
          );
        if (historyFirst) snapshot();
        const start = {
          type: "start",
          attemptId: "attempt",
          revision: 1,
          turn: 1,
          step: 0,
        };
        stream(start);
        stream({
          type: "chunk",
          attemptId: "attempt",
          revision: 2,
          chunk: { type: "text-delta", text: "New reply" },
        });
        if (!historyFirst) snapshot();
        assert.equal(state.liveAssistant.s?.text, "New reply", boundary.type);
        const streamId = state.liveAssistant.s.streamId;
        // Receiving another durable event later must not retroactively move
        // this attempt's unknown start cursor across an old HTTP boundary.
        links.observe({
          type: "session/event",
          sessionId: "s",
          event: { seq: 11, type: "system/message", data: {} },
        });
        stream(start);
        stream({
          type: "chunk",
          attemptId: "attempt",
          revision: 3,
          chunk: { type: "text-delta", text: " continues" },
        });
        snapshot();
        assert.equal(state.liveAssistant.s?.text, "New reply continues");
        assert.deepEqual(
          state.events,
          [boundary],
          "old records cannot inherit this stream",
        );

        // An ordered mux final has an exact stream identity even when its
        // opening durable cursor was unavailable. It must still settle once.
        const completed = links.observe({
          type: "session/event",
          sessionId: "s",
          event: final(12, {
            message: {
              content: [{ type: "text", text: "New reply continues" }],
            },
          }),
        }).event;
        setHistoryEvents(state, mergeEvents(state.events, [completed]));
        assert.equal(state.liveAssistant.s, null);
        assert.equal(state.events.at(-1).data.streamId, streamId);
        stream(start);
        assert.equal(
          state.liveAssistant.s,
          null,
          "replayed starts cannot reopen the completed reply",
        );
      }
    });

test("a negative cursor cannot retire a stream from an existing turn boundary", () => {
  const { state } = streaming();
  state.liveAssistant.s.afterSeq = -1;
  const live = state.liveAssistant.s;
  setHistoryEvents(state, [{ seq: 10, type: "turn/start", data: { turn: 1 } }]);
  assert.equal(state.liveAssistant.s, live);
});

test("incomplete stream identity does not infer a final from identical prose", () => {
  for (const missing of ["turn", "step", "afterSeq"]) {
    const { state } = streaming();
    delete state.liveAssistant.s[missing];
    const live = state.liveAssistant.s;
    setHistoryEvents(state, [final()]);
    assert.equal(state.liveAssistant.s, live);
    assert.equal(state.events[0].data.attemptId, undefined);
  }
});

test("history reconciliation is scoped to the selected session", () => {
  const { state, frame } = streaming();
  const live = state.liveAssistant.s;
  state.selectedId = "other";
  setHistoryEvents(state, [final()]);
  setAssistantStream(state, "s", { ...frame, attemptId: "next" });
  assert.equal(state.liveAssistant.s.attemptId, "next");
  assert.equal(state.events[0].data.attemptId, undefined);
  state.liveAssistant.s = live;
  state.selectedId = "s";
  setHistoryEvents(state, [final()]);
  assert.equal(state.liveAssistant.s, null);
  assert.equal(state.events[0].data.attemptId, "attempt");
});

test("merging aliases respects explicit identities, turns, steps and event types", () => {
  const previous = final(11, { attemptId: "attempt" });
  for (const incoming of [
    final(11, { attemptId: "explicit" }),
    final(11, { turn: 2 }),
    final(11, { step: 1 }),
    { seq: 11, type: "tool/call", data: {} },
  ]) {
    const [merged] = mergeEvents([previous], [incoming]);
    assert.equal(merged, incoming);
  }
});

test("HTTP refresh retains stream identity only for the same durable reply", () => {
  const old = final(11, { attemptId: "attempt", streamId: "old-stream" });
  for (const incoming of [final(), final(11, { attemptId: "attempt" })]) {
    const [merged] = mergeEvents([old], [incoming]);
    assert.equal(merged.data.streamId, "old-stream");
    assert.equal(incoming.data.streamId, undefined);
  }
  for (const incoming of [
    final(11, { attemptId: "other" }),
    final(11, { attemptId: "attempt", streamId: "new-stream" }),
    final(11, { turn: 2 }),
  ])
    assert.equal(mergeEvents([old], [incoming])[0], incoming);
});

test("an explicit identity from another stream cannot consume the active stream", () => {
  const { state } = streaming();
  const live = state.liveAssistant.s;
  setHistoryEvents(state, [
    final(11, { attemptId: live.attemptId, streamId: "old-stream" }),
  ]);
  assert.equal(state.liveAssistant.s, live);
});

for (const historyFirst of [false, true])
  test(`reconnecting after an Agent restart keeps reused attempt IDs live; HTTP first = ${historyFirst}`, () => {
    const { links, state } = streaming();
    const receive = (raw) => {
      const event = links.observe({
        type: "session/event",
        sessionId: "s",
        event: raw,
      }).event;
      setHistoryEvents(state, mergeEvents(state.events, [event]));
    };
    const stream = (frame) =>
      setAssistantStream(
        state,
        "s",
        links.observe({
          type: "session/assistant-stream",
          sessionId: "s",
          frame,
        }).frame,
      );
    const old = final();
    receive(old);
    const oldAlias = projectSession(state.events).messages[0].anchorIds[0];
    links.reset();
    state.liveAssistant = {};
    // Reconnection keeps displayed history and refreshes it from raw HTTP.
    setHistoryEvents(
      state,
      mergeEvents(state.events, links.history("s", [old])),
    );
    receive({ seq: 12, type: "turn/start", data: { turn: 2 } });
    receive({ seq: 13, type: "step/start", data: { turn: 2, step: 1 } });
    stream({
      type: "start",
      attemptId: "attempt",
      revision: 1,
      turn: 2,
      step: 1,
    });
    stream({
      type: "chunk",
      attemptId: "attempt",
      revision: 2,
      chunk: { type: "text-delta", text: "New reply" },
    });
    assert.equal(
      state.liveAssistant.s?.text,
      "New reply",
      "the old final cannot consume a new lifecycle",
    );
    const live = state.liveAssistant.s;
    const newAlias = liveMessageId(live.attemptId, live.streamId);
    assert.notEqual(
      newAlias,
      oldAlias,
      "viewport anchors must distinguish both replies",
    );
    const next = final(14, {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "New reply" }] },
    });
    if (historyFirst) {
      setHistoryEvents(
        state,
        mergeEvents(state.events, links.history("s", [next])),
      );
      assert.equal(state.liveAssistant.s, null);
      setHistoryEvents(
        state,
        mergeEvents(state.events, links.history("s", [next])),
      );
    }
    receive(next);
    assert.equal(state.liveAssistant.s, null);
    const messages = projectSession(state.events).messages;
    assert.deepEqual(
      messages.map((message) => message.text),
      ["Same reply", "New reply"],
    );
    assert.deepEqual(
      messages.map((message) => message.anchorIds),
      [[oldAlias], [newAlias]],
    );
  });
