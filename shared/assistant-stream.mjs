import { reduceTextBlocks } from "./message-text.mjs";

/** Shared identity for an in-flight reply and its eventual history alias.
 * @param {string} attemptId @param {string} [streamId] */
export function liveMessageId(attemptId, streamId) {
  return `live-${streamId ?? attemptId}`;
}

/** Desktop 0.2 streams have their own revision; never invent durable Session sequence numbers. */
export function reduceAssistantStream(previous, frame) {
  if (!Number.isSafeInteger(frame?.revision)) return previous;
  if (
    frame.type === "start" &&
    previous?.attemptId === frame.attemptId &&
    previous?.streamId === frame.streamId &&
    frame.revision <= previous.revision
  )
    return previous;
  if (frame.type === "start")
    return {
      attemptId: frame.attemptId,
      revision: frame.revision,
      text: "",
      ...(typeof frame.streamId === "string"
        ? { streamId: frame.streamId }
        : {}),
      ...(frame.turn !== undefined ? { turn: frame.turn } : {}),
      ...(frame.step !== undefined ? { step: frame.step } : {}),
      ...(Number.isSafeInteger(frame.afterSeq) && frame.afterSeq >= 0
        ? { afterSeq: frame.afterSeq }
        : {}),
    };
  if (
    !previous ||
    frame.attemptId !== previous.attemptId ||
    frame.streamId !== previous.streamId ||
    frame.revision <= previous.revision
  )
    return previous;
  if (frame.type === "end") return null;
  if (frame.type !== "chunk" || frame.revision !== previous.revision + 1)
    return null;
  return {
    ...reduceTextBlocks(previous, frame.chunk),
    revision: frame.revision,
  };
}

/** Reconcile a durable snapshot and its still-in-flight mux reply atomically.
 * @param {any[]} events @param {any} live */
export function reconcileAssistantHistory(events, live) {
  if (!live) return { events, live };
  const hasCursor = Number.isSafeInteger(live.afterSeq) && live.afterSeq >= 0;
  // HTTP can observe a failed attempt (or a new turn) before its mux
  // notification. Retire that draft without lending its alias to a retry.
  const boundary = hasCursor
    ? events.find(
        (event) =>
          event.seq > live.afterSeq &&
          [
            "assistant/message",
            "assistant/attempt",
            "turn/start",
            "turn/end",
          ].includes(event.type),
      )
    : undefined;
  if (
    live.turn !== undefined &&
    ((boundary?.type === "turn/start" && boundary.data?.turn !== undefined) ||
      (boundary?.type === "turn/end" && boundary.data?.turn === live.turn) ||
      (boundary?.type === "assistant/attempt" &&
        boundary.data?.turn === live.turn &&
        live.step !== undefined &&
        boundary.data?.step === live.step &&
        (typeof boundary.data?.attemptId !== "string" ||
          boundary.data.attemptId === live.attemptId) &&
        (boundary.data?.streamId === undefined ||
          boundary.data.streamId === live.streamId)))
  )
    return { events, live: null };
  let final = events.find(
    (event) =>
      event.type === "assistant/message" &&
      event.data?.attemptId === live.attemptId &&
      // DSH attempt counters can be reused after an Agent restart. Without a
      // start cursor, only the exact mux scope proves a final is this reply.
      // Codex item IDs have no such process-local counter or stream scope.
      (hasCursor ||
        live.streamId === undefined ||
        event.data?.streamId === live.streamId) &&
      (event.data?.streamId === undefined ||
        event.data.streamId === live.streamId) &&
      (live.turn === undefined || event.data?.turn === live.turn) &&
      (live.step === undefined || event.data?.step === live.step) &&
      (!hasCursor || event.seq > live.afterSeq),
  );
  if (
    !final &&
    hasCursor &&
    live.turn !== undefined &&
    live.step !== undefined
  ) {
    // Older DSH hosts omit attemptId. Only the first terminal boundary after
    // the ordered start can belong to this attempt; never jump across a
    // failed attempt or turn boundary to match a retry with identical prose.
    if (
      boundary?.type === "assistant/message" &&
      boundary.data?.turn === live.turn &&
      boundary.data?.step === live.step &&
      typeof boundary.data?.attemptId !== "string" &&
      (boundary.data?.streamId === undefined ||
        boundary.data.streamId === live.streamId) &&
      boundary.surfaceOp !== "replace" &&
      typeof boundary.surfaceOp !== "object"
    )
      final = boundary;
  }
  if (!final) return { events, live };
  return {
    events:
      final.data?.attemptId === live.attemptId &&
      final.data?.streamId === live.streamId
        ? events
        : events.map((event) =>
            event === final
              ? {
                  ...event,
                  data: {
                    ...event.data,
                    attemptId: live.attemptId,
                    ...(live.streamId ? { streamId: live.streamId } : {}),
                  },
                }
              : event,
          ),
    live: null,
  };
}
