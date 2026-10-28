import test from "node:test";
import assert from "node:assert/strict";
import { projectSession } from "../shared/projection.mjs";

const chunk = (seq, index, text) => ({
  seq,
  type: "assistant/chunk",
  data: { turn: 1, step: 0, chunk: { type: "text-delta", index, text } },
});
const final = (seq, texts) => ({
  seq,
  type: "assistant/message",
  data: {
    turn: 1,
    step: 0,
    message: { content: texts.map((text) => ({ type: "text", text })) },
  },
});
const anchorFor = (message, event) =>
  message.textAnchors.find(({ id }) => id === `partial-1:0-${event.seq}`);
const blockEnd = (seq, index, text) => ({
  seq,
  type: "assistant/chunk",
  data: {
    turn: 1,
    step: 0,
    chunk: { type: "block-end", index, block: { type: "text", text } },
  },
});

test("legacy block boundaries preserve Markdown and every delta's source range", () => {
  const chunks = [
    chunk(1, 0, "Here is the output:"),
    chunk(2, 1, "```text\nReading marker\n```"),
    chunk(3, 1, "\nMore text"),
  ];
  const texts = [
    chunks[0].data.chunk.text,
    chunks[1].data.chunk.text + chunks[2].data.chunk.text,
  ];
  for (const events of [chunks, [...chunks, final(4, texts)]]) {
    const [message] = projectSession(events, true).messages;
    assert.equal(message.text, texts.join("\n"));
    assert.equal(anchorFor(message, chunks[1]).start, texts[0].length + 1);
    for (const event of chunks) {
      const anchor = anchorFor(message, event);
      assert.ok(anchor, "completion must retain each delta's character anchor");
      assert.equal(
        message.text.slice(anchor.start, anchor.end),
        event.data.chunk.text,
      );
    }
  }
});

test("interleaved legacy blocks move later anchors when an earlier block grows", () => {
  const chunks = [
    chunk(1, 0, "Hel"),
    chunk(2, 3, "World"),
    chunk(3, 0, "lo"),
    chunk(4, 3, "!"),
  ];
  const earlier = projectSession(chunks.slice(0, 2), true).messages[0];
  assert.equal(earlier.text, "Hel\nWorld");
  for (const events of [chunks, [...chunks, final(5, ["Hello", "World!"])]]) {
    const [message] = projectSession(events, true).messages;
    assert.equal(message.text, "Hello\nWorld!");
    assert.equal(anchorFor(message, chunks[1]).start, "Hello\n".length);
    for (const event of chunks) {
      const anchor = anchorFor(message, event);
      assert.equal(
        message.text.slice(anchor.start, anchor.end),
        event.data.chunk.text,
      );
    }
  }
  assert.equal(
    earlier.text,
    "Hel\nWorld",
    "earlier projections stay immutable",
  );
});

for (const loadedFrom of [1, 2])
  test(`partially loaded interleaved blocks retain final source offsets; from = ${loadedFrom}`, () => {
    // Stream indices identify blocks; neither their numeric value nor their
    // first appearance in a partial page determines the final content order.
    const chunks = [
      chunk(1, 9, "First prefix "),
      chunk(2, 4, "Second prefix "),
      chunk(3, 9, "first tail"),
      chunk(4, 4, "second tail"),
    ];
    const texts = ["First prefix first tail", "Second prefix second tail"];
    const loaded = chunks.slice(loadedFrom);
    const before = projectSession(loaded, true).messages[0];
    const beforeSnapshot = structuredClone(before);
    for (const events of [loaded, chunks]) {
      const [message] = projectSession([...events, final(5, texts)]).messages;
      assert.equal(message.text, texts.join("\n"));
      assert.ok(message.anchorIds.includes(before.id));
      for (const event of loaded) {
        const anchor = anchorFor(message, event);
        assert.ok(
          anchor,
          "finalization must retain each loaded block's anchors",
        );
        assert.equal(
          message.text.slice(anchor.start, anchor.end),
          event.data.chunk.text,
        );
      }
      assert.equal(anchorFor(message, chunks[2]).start, "First prefix ".length);
      assert.equal(
        anchorFor(message, chunks[3]).start,
        texts[0].length + 1 + "Second prefix ".length,
      );
    }
    assert.deepEqual(
      before,
      beforeSnapshot,
      "published projections stay immutable",
    );
  });

test("interleaved block matching disambiguates a suffix already owned by another block", () => {
  const chunks = [
    chunk(2, 8, "Other repeated tail"),
    chunk(3, 4, "repeated tail"),
  ];
  const texts = ["First repeated tail", "Other repeated tail"];
  const [message] = projectSession([...chunks, final(4, texts)]).messages;
  assert.equal(anchorFor(message, chunks[0]).start, texts[0].length + 1);
  assert.equal(anchorFor(message, chunks[1]).start, "First ".length);
});

test("ambiguous or rewritten blocks do not discard other blocks' final anchors", () => {
  for (const tail of ["repeated tail", "rewritten tail"]) {
    const chunks = [chunk(2, 8, "Unique block"), chunk(3, 4, tail)];
    const texts = [
      "First repeated tail",
      "Second repeated tail",
      "Unique block",
    ];
    const [message] = projectSession([...chunks, final(4, texts)]).messages;
    assert.equal(
      anchorFor(message, chunks[0]).start,
      texts[0].length + 1 + texts[1].length + 1,
    );
    assert.equal(
      anchorFor(message, chunks[1]),
      undefined,
      "do not guess a changed or ambiguous block's location",
    );
  }
});

test("a canonical block end distinguishes a complete block from a longer repeated suffix", () => {
  const unique = chunk(2, 8, "Unique block");
  const end = {
    seq: 3,
    type: "assistant/chunk",
    data: {
      turn: 1,
      step: 0,
      chunk: {
        type: "block-end",
        index: 4,
        block: { type: "text", text: "Tail" },
      },
    },
  };
  const [message] = projectSession([
    unique,
    end,
    final(4, ["Tail", "Prefix Tail", "Unique block"]),
  ]).messages;
  assert.equal(anchorFor(message, end).start, 0);
  assert.equal(anchorFor(message, end).end, "Tail".length);
  assert.equal(anchorFor(message, unique).start, "Tail\nPrefix Tail\n".length);
});

for (const texts of [
  ["Tail", "Prefix Tail"],
  ["Prefix Tail", "Tail"],
])
  test(`a closed block maps to its complete occurrence before considering a message suffix: ${texts.join(" / ")}`, () => {
    const end = blockEnd(4, 9, "Tail");
    const [message] = projectSession([end, final(5, texts)]).messages;
    const anchor = anchorFor(message, end);
    const expected = texts[0] === "Tail" ? 0 : texts[0].length + 1;
    assert.equal(anchor.start, expected);
    assert.equal(anchor.end, expected + "Tail".length);
  });

test("closed block matching keeps text-only offsets across nontext and empty blocks", () => {
  const end = blockEnd(4, 9, "Tail");
  const completed = final(5, ["", "Tail", "Prefix Tail"]);
  completed.data.message.content.splice(1, 0, {
    type: "reasoning",
    text: "Hidden",
  });
  const [message] = projectSession([end, completed]).messages;
  assert.equal(message.text, "\nTail\nPrefix Tail");
  assert.equal(anchorFor(message, end).start, 1);
});

test("a structured final cannot place a closed block inside a different block", () => {
  const end = blockEnd(4, 9, "Tail");
  const [message] = projectSession([end, final(5, ["Prefix Tail"])]).messages;
  assert.equal(anchorFor(message, end), undefined);
});

test("legacy string finals retain suffix anchors without structured block metadata", () => {
  const end = blockEnd(4, 9, "Tail");
  const completed = {
    seq: 5,
    type: "assistant/message",
    data: { turn: 1, step: 0, message: { content: "Prefix Tail" } },
  };
  const [message] = projectSession([end, completed]).messages;
  assert.equal(anchorFor(message, end).start, "Prefix ".length);
});

for (const phase of ["streaming", "interrupted", "final"])
  test(`corrected replies keep explicit partial identity until a final arrives; ${phase}`, () => {
    const delta = chunk(3, 1, "Draft placeholder");
    const end = blockEnd(4, 1, "Canonical body");
    const events = [delta, end];
    if (phase === "interrupted")
      events.push({
        seq: 5,
        type: "turn/end",
        data: { turn: 1, reason: { kind: "aborted" } },
      });
    if (phase === "final") events.push(final(5, ["Canonical body"]));
    const [message] = projectSession(events, phase === "streaming").messages;
    assert.equal(message.partial, phase !== "final");
    assert.equal(message.streaming, phase === "streaming");
    assert.equal(message.id, phase === "final" ? "event-5" : "partial-1:0-3");
    assert.equal(
      anchorFor(message, delta),
      undefined,
      "the rewritten delta has no valid source range",
    );
    assert.equal(anchorFor(message, end).start, 0);
  });

for (const loadedFrom of [1, 2])
  for (const completed of [false, true])
    test(`legacy block/chunk backfill preserves the loaded suffix; from = ${loadedFrom}, completed = ${completed}`, () => {
      const chunks = [
        chunk(1, 0, "Repeated text"),
        chunk(2, 1, "Repeated "),
        chunk(3, 1, "text"),
        chunk(4, 2, "Last block"),
      ];
      const texts = ["Repeated text", "Repeated text", "Last block"];
      const loaded = chunks.slice(loadedFrom);
      const before = projectSession(loaded, true).messages[0];
      for (const events of [
        [...chunks, ...(completed ? [final(5, texts)] : [])],
        // The final alone can supply the missing prefix before its older page.
        ...(completed ? [[...loaded, final(5, texts)]] : []),
      ]) {
        const [message] = projectSession(events, !completed).messages;
        assert.equal(message.text, texts.join("\n"));
        assert.ok(message.anchorIds.includes(before.id));
        for (const event of loaded) {
          const anchor = anchorFor(message, event);
          assert.ok(anchor);
          assert.equal(
            message.text.slice(anchor.start, anchor.end),
            event.data.chunk.text,
          );
        }
        assert.equal(
          anchorFor(message, chunks[2]).start,
          "Repeated text\nRepeated ".length,
        );
      }
    });

test("a legacy block end can supply a missing prefix without losing delta anchors", () => {
  const tail = chunk(3, 1, "Tail");
  const end = {
    seq: 4,
    type: "assistant/chunk",
    data: {
      turn: 1,
      step: 0,
      chunk: {
        type: "block-end",
        index: 1,
        block: { type: "text", text: "Prefix Tail" },
      },
    },
  };
  for (const events of [
    [tail, end],
    [tail, end, final(5, ["First block", "Prefix Tail"])],
  ]) {
    const [message] = projectSession(events, true).messages;
    const anchor = anchorFor(message, tail);
    assert.ok(anchor);
    assert.equal(message.text.slice(anchor.start, anchor.end), "Tail");
    assert.equal(anchor.start, message.text.length - "Tail".length);
  }
});

test("legacy blocks and their anchors do not leak into a later reply", () => {
  const old = [chunk(1, 0, "Old"), chunk(2, 1, "reply")];
  for (const boundary of [
    final(3, ["Old", "reply"]),
    {
      seq: 3,
      type: "turn/end",
      data: { turn: 1, reason: { kind: "aborted" } },
    },
  ]) {
    const messages = projectSession(
      [...old, boundary, chunk(4, 1, "New reply")],
      true,
    ).messages;
    assert.deepEqual(
      messages.map(({ text }) => text),
      ["Old\nreply", "New reply"],
    );
    assert.equal(messages[1].textAnchors.length, 1);
    assert.equal(messages[1].textAnchors[0].start, 0);
    assert.ok(
      messages[0].anchorIds.every((id) => !messages[1].anchorIds.includes(id)),
    );
  }
});
