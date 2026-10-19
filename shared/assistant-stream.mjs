/** Desktop 0.2 streams have their own revision; never invent durable Session sequence numbers. */
export function reduceAssistantStream(previous, frame) {
  if (!Number.isSafeInteger(frame?.revision)) return previous;
  if (
    frame.type === "start" &&
    previous?.attemptId === frame.attemptId &&
    frame.revision <= previous.revision
  )
    return previous;
  if (frame.type === "start")
    return { attemptId: frame.attemptId, revision: frame.revision, text: "" };
  if (
    !previous ||
    frame.attemptId !== previous.attemptId ||
    frame.revision <= previous.revision
  )
    return previous;
  if (frame.type === "end") return null;
  if (frame.type !== "chunk" || frame.revision !== previous.revision + 1)
    return null;
  return {
    ...previous,
    revision: frame.revision,
    text:
      previous.text +
      (frame.chunk?.type === "text-delta" ? frame.chunk.text : ""),
  };
}
