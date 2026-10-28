import { endStatus } from "./activity.mjs";
import { toolPresentation } from "./tool-presentation.mjs";
import { liveMessageId } from "./assistant-stream.mjs";
import {
  contentText,
  reduceTextBlocks,
  textBlockIndex,
} from "./message-text.mjs";
export { contentText } from "./message-text.mjs";

/** @param {any[]} previous @param {any[]} incoming */
export function mergeEvents(previous, incoming) {
  const events = new Map(previous.map((event) => [event.seq, event]));
  for (const event of incoming) {
    if (!Number.isSafeInteger(event?.seq)) continue;
    const previous = events.get(event.seq);
    // A raw HTTP read can race ahead of the mux identity cache. Once the
    // final has inherited its live anchor, later reads must retain it.
    const sameReply =
      event.type === "assistant/message" &&
      previous?.type === event.type &&
      previous.data?.turn === event.data?.turn &&
      previous.data?.step === event.data?.step;
    const keepAttempt =
      sameReply &&
      typeof previous.data?.attemptId === "string" &&
      typeof event.data?.attemptId !== "string";
    const keepStream =
      sameReply &&
      typeof previous.data?.streamId === "string" &&
      typeof event.data?.streamId !== "string" &&
      (keepAttempt || event.data?.attemptId === previous.data?.attemptId);
    events.set(
      event.seq,
      keepAttempt || keepStream
        ? {
            ...event,
            data: {
              ...event.data,
              ...(keepAttempt ? { attemptId: previous.data.attemptId } : {}),
              ...(keepStream ? { streamId: previous.data.streamId } : {}),
            },
          }
        : event,
    );
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

function materializePartial(partial) {
  const { message, stream, anchors } = partial;
  message.text = stream.text;
  let offset = 0;
  // Chunk ranges are relative to their own block until assembly is complete:
  // an earlier block can grow after a later block has already emitted text.
  message.textAnchors = stream.textBlocks.flatMap((block) => {
    const ranges = (anchors.get(block.index) || []).map((anchor) => ({
      id: anchor.id,
      start: offset + anchor.start,
      end: offset + anchor.end,
    }));
    offset += block.text.length + 1;
    return ranges;
  });
}

function finalTextAnchors(partial, content, text) {
  const { message, stream, anchors } = partial;
  // Old string finals have no block boundaries to validate against.
  if (!Array.isArray(content)) {
    if (!text.endsWith(message.text)) return [];
    const prefix = text.length - message.text.length;
    return message.textAnchors.map((anchor) => ({
      ...anchor,
      start: anchor.start + prefix,
      end: anchor.end + prefix,
    }));
  }
  // A page can miss the starts of several interleaved blocks. Each loaded
  // block is still a suffix, but their concatenation need not be one. Stream
  // indices are identities, not positions in the final content array.
  let offset = 0;
  const blocks = content
    .filter((block) => block.type === "text")
    .map((block) => {
      const text = block.text || "";
      const result = { text, start: offset };
      offset += text.length + 1;
      return result;
    });
  let pending = stream.textBlocks.map((block) => ({
    block,
    candidates: blocks.filter((final) =>
      block.closed
        ? final.text === block.text
        : final.text.endsWith(block.text),
    ),
  }));
  const placements = new Map();
  while (pending.length) {
    const claims = new Map();
    for (const { candidates } of pending)
      if (candidates.length === 1)
        claims.set(candidates[0], (claims.get(candidates[0]) || 0) + 1);
    const resolved = pending.filter(
      ({ candidates }) =>
        candidates.length === 1 && claims.get(candidates[0]) === 1,
    );
    if (!resolved.length) break;
    const used = new Set();
    for (const { block, candidates } of resolved) {
      placements.set(block.index, candidates[0]);
      used.add(candidates[0]);
    }
    // A uniquely identified block cannot also belong to another suffix.
    // Leave unresolved repeated/rewritten blocks without a character anchor.
    pending = pending
      .filter(({ block }) => !placements.has(block.index))
      .map((row) => ({
        ...row,
        candidates: row.candidates.filter((candidate) => !used.has(candidate)),
      }));
  }
  // Repeated blocks may still be identified by the ordered suffix, but only
  // when every range fits a corresponding block and agrees with the unique
  // matches above. A closed "Tail" must never land inside "Prefix Tail".
  if (text.endsWith(message.text)) {
    let offset = text.length - message.text.length;
    const ordered = stream.textBlocks.map((block) => {
      const final = blocks.find(
        (candidate) =>
          candidate.start + candidate.text.length - block.text.length ===
            offset &&
          (block.closed
            ? candidate.text === block.text
            : candidate.text.endsWith(block.text)),
      );
      offset += block.text.length + 1;
      return { block, final };
    });
    if (
      ordered.every(
        ({ block, final }) =>
          final &&
          (!placements.has(block.index) ||
            placements.get(block.index) === final),
      ) &&
      new Set(ordered.map(({ final }) => final)).size === ordered.length
    )
      for (const { block, final } of ordered)
        placements.set(block.index, final);
  }
  return stream.textBlocks.flatMap((block) => {
    const final = placements.get(block.index);
    if (!final) return [];
    const start = final.start + final.text.length - block.text.length;
    return (anchors.get(block.index) || []).map((anchor) => ({
      ...anchor,
      start: start + anchor.start,
      end: start + anchor.end,
    }));
  });
}

/** @param {any[]} events @param {boolean} running */
export function projectSession(events, running = false) {
  /** @type {any[]} */
  const messages = [];
  const partials = new Map();
  let status = running ? "thinking" : "idle",
    lastTool = "",
    endReason = "";
  for (const event of events) {
    const data = event.data || {},
      key = `${data.turn}:${data.step}`;
    if (event.type === "turn/start") {
      status = "thinking";
      endReason = "";
    }
    if (
      event.type === "user/message" &&
      (!data.source || data.source.kind === "user") &&
      event.surfaceOp !== "replace" &&
      typeof event.surfaceOp !== "object"
    ) {
      messages.push({
        id: event.id ?? `event-${event.seq}`,
        role: "user",
        text: contentText(data.content),
        seq: event.seq,
      });
    }
    if (event.type === "assistant/chunk") {
      const chunkId = `partial-${key}-${event.seq}`;
      let partial = partials.get(key);
      const previous = partial?.stream || { text: "" };
      const stream = reduceTextBlocks(previous, data.chunk);
      if (stream === previous) continue;
      if (!partial) {
        const message = {
          id: chunkId,
          anchorIds: [],
          textAnchors: [],
          role: "assistant",
          text: "",
          streaming: true,
          partial: true,
          seq: event.seq,
        };
        partial = { message, stream, anchors: new Map() };
        partials.set(key, partial);
        messages.push(message);
      }
      partial.stream = stream;
      const index = textBlockIndex(data.chunk);
      const before =
        previous.textBlocks?.find((block) => block.index === index)?.text || "";
      const after = stream.textBlocks.find(
        (block) => block.index === index,
      ).text;
      let ranges = partial.anchors.get(index) || [];
      if (data.chunk.type === "block-end") {
        // A loaded page can begin midway through this block. Its canonical
        // ending supplies the missing prefix without changing chunk identity.
        const prefix = after.endsWith(before)
          ? after.length - before.length
          : after.startsWith(before)
            ? 0
            : -1;
        ranges =
          prefix < 0
            ? []
            : ranges.map((anchor) => ({
                ...anchor,
                start: anchor.start + prefix,
                end: anchor.end + prefix,
              }));
      }
      // Any loaded chunk can have been the first chunk in a previous page.
      // Retain those identities across prefix backfill and finalization.
      partial.message.anchorIds.push(chunkId);
      ranges.push({
        id: chunkId,
        start: data.chunk.type === "text-delta" ? before.length : 0,
        end: after.length,
      });
      partial.anchors.set(index, ranges);
      status = "thinking";
    }
    if (event.type === "assistant/message") {
      const inFlight = partials.get(key);
      if (inFlight) materializePartial(inFlight);
      const partial = inFlight?.message;
      const text = contentText(data.message?.content);
      const anchorIds =
        typeof data.attemptId === "string"
          ? [liveMessageId(data.attemptId, data.streamId)]
          : [];
      if (partial) {
        // A completed reply has the same canonical ID whether its earlier
        // streamed chunks were present in the initial page or loaded later.
        partial.id = event.id ?? `event-${event.seq}`;
        partial.seq = event.seq;
        partial.anchorIds.push(...anchorIds);
        partial.textAnchors = finalTextAnchors(
          inFlight,
          data.message?.content,
          text,
        );
        partial.textAnchors.push(
          ...anchorIds.map((id) => ({ id, start: 0, end: text.length })),
        );
        partial.text = text;
        partial.streaming = false;
        partial.partial = false;
        partials.delete(key);
      } else if (
        text &&
        typeof event.surfaceOp !== "object" &&
        event.surfaceOp !== "replace"
      )
        messages.push({
          id: event.id ?? `event-${event.seq}`,
          ...(anchorIds.length ? { anchorIds } : {}),
          ...(anchorIds.length
            ? {
                textAnchors: anchorIds.map((id) => ({
                  id,
                  start: 0,
                  end: text.length,
                })),
              }
            : {}),
          role: "assistant",
          text,
          seq: event.seq,
        });
    }
    if (event.type === "tool/call") {
      lastTool = data.name || "工具";
      status = "tool";
      messages.push({
        id: event.id ?? `event-${event.seq}`,
        role: "tool",
        text: lastTool,
        ...toolPresentation(data),
        seq: event.seq,
      });
    }
    if (event.type === "tool/result") {
      status = "thinking";
    }
    if (event.type === "turn/end") {
      endReason =
        typeof data.reason === "string"
          ? data.reason
          : data.reason?.kind || data.reason?.type || "";
      status = endStatus(data.reason);
      for (const partial of partials.values()) {
        materializePartial(partial);
        partial.message.streaming = false;
      }
      partials.clear();
    }
  }
  for (const partial of partials.values()) materializePartial(partial);
  if (!running && ["thinking", "tool"].includes(status)) status = "idle";
  return {
    messages: messages.filter((m) => m.text),
    status,
    lastTool,
    endReason,
  };
}

/** @param {any} session */
export function sessionTitle(session) {
  const title = session.projections?.values?.title;
  return (
    (typeof title === "string" ? title : title?.title) ||
    session.title ||
    (session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() : "") ||
    "新的对话"
  );
}
