import test from "node:test";
import assert from "node:assert/strict";
import { reduceAssistantStream } from "../shared/assistant-stream.mjs";
import { projectSession } from "../shared/projection.mjs";

const start = (attemptId = "attempt") => ({
  type: "start",
  attemptId,
  revision: 1,
});
const delta = (index, text) => ({ type: "text-delta", index, text });
const open = (index, blockType = "text") => ({
  type: "block-start",
  index,
  blockType,
});
const end = (index, text) => ({
  type: "block-end",
  index,
  block: { type: "text", text },
});

for (const [name, chunks, texts] of [
  [
    "separate text blocks",
    [
      open(0),
      delta(0, "First"),
      end(0, "First"),
      open(1),
      delta(1, "Second"),
      end(1, "Second"),
    ],
    ["First", "Second"],
  ],
  [
    "delta-only blocks",
    [delta(0, "Hello"), delta(0, " world"), delta(2, "Next")],
    ["Hello world", "Next"],
  ],
  [
    "interleaved text blocks",
    [
      open(4),
      open(9),
      delta(9, "Second"),
      delta(4, "First"),
      delta(9, " continued"),
    ],
    ["First", "Second continued"],
  ],
  [
    "empty text blocks",
    [open(0), end(0, ""), delta(1, "Next"), end(2, "")],
    ["", "Next", ""],
  ],
  [
    "complete blocks without deltas",
    [end(0, "First"), end(2, "Second")],
    ["First", "Second"],
  ],
  [
    "canonical block endings",
    [
      delta(0, "Partial"),
      end(0, "Final"),
      delta(0, "Ignored"),
      end(0, "Duplicate"),
      delta(1, "Next"),
    ],
    ["Final", "Next"],
  ],
  [
    "reasoning and tool blocks",
    [
      open(0, "reasoning"),
      { type: "reasoning-delta", index: 0, text: "Hidden" },
      delta(1, "First"),
      open(2, "tool-call"),
      { type: "tool-call-delta", index: 2, argumentsDelta: "{}" },
      delta(3, "Second"),
    ],
    ["First", "Second"],
  ],
  [
    "unindexed Codex and legacy deltas",
    [delta(undefined, "Hello"), delta(undefined, " world")],
    ["Hello world"],
  ],
]) {
  test(`streamed and final text use the same source offsets for ${name}`, () => {
    let live = reduceAssistantStream(null, start());
    let revision = 1;
    for (const chunk of chunks)
      live = reduceAssistantStream(live, {
        type: "chunk",
        attemptId: "attempt",
        revision: ++revision,
        chunk,
      });
    const final = projectSession([
      {
        seq: 1,
        type: "assistant/message",
        data: {
          message: { content: texts.map((text) => ({ type: "text", text })) },
        },
      },
    ]).messages[0];
    assert.equal(live.text, texts.join("\n"));
    assert.equal(live.text, final.text);
  });

  test(`legacy stream and final text agree for ${name}`, () => {
    const events = chunks.map((chunk, seq) => ({
      seq,
      type: "assistant/chunk",
      data: { turn: 1, step: 0, chunk },
    }));
    const streamed = projectSession(events, true).messages;
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].text, texts.join("\n"));
    const completed = projectSession([
      ...events,
      {
        seq: chunks.length,
        type: "assistant/message",
        data: {
          turn: 1,
          step: 0,
          message: { content: texts.map((text) => ({ type: "text", text })) },
        },
      },
    ]).messages;
    assert.equal(completed.length, 1);
    assert.equal(completed[0].text, streamed[0].text);
    assert.equal(completed[0].streaming, false);
  });
}

test("a new attempt starts with no blocks from the previous reply", () => {
  let live = reduceAssistantStream(null, start());
  live = reduceAssistantStream(live, {
    type: "chunk",
    attemptId: "attempt",
    revision: 2,
    chunk: delta(4, "Old"),
  });
  const previous = live;
  live = reduceAssistantStream(live, start("retry"));
  live = reduceAssistantStream(live, {
    type: "chunk",
    attemptId: "retry",
    revision: 2,
    chunk: delta(8, "New"),
  });
  assert.equal(previous.text, "Old", "published snapshots are immutable");
  assert.equal(live.text, "New");
});
