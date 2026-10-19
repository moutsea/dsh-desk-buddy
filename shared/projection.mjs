import { endStatus } from "./activity.mjs";

/** @param {any[]} previous @param {any[]} incoming */
export function mergeEvents(previous, incoming) {
  const events = new Map(previous.map((event) => [event.seq, event]));
  for (const event of incoming)
    if (Number.isSafeInteger(event?.seq)) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

/** @param {any} value */
export function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
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
        id: `event-${event.seq}`,
        role: "user",
        text: contentText(data.content),
        seq: event.seq,
      });
    }
    if (event.type === "assistant/chunk" && data.chunk?.type === "text-delta") {
      let message = partials.get(key);
      if (!message) {
        message = {
          id: `partial-${key}-${event.seq}`,
          role: "assistant",
          text: "",
          streaming: true,
          seq: event.seq,
        };
        partials.set(key, message);
        messages.push(message);
      }
      message.text += data.chunk.text;
      status = "thinking";
    }
    if (event.type === "assistant/message") {
      const partial = partials.get(key);
      const text = contentText(data.message?.content);
      if (partial) {
        partial.text = text;
        partial.streaming = false;
        partials.delete(key);
      } else if (
        text &&
        typeof event.surfaceOp !== "object" &&
        event.surfaceOp !== "replace"
      )
        messages.push({
          id: `event-${event.seq}`,
          role: "assistant",
          text,
          seq: event.seq,
        });
    }
    if (event.type === "tool/call") {
      lastTool = data.name || "工具";
      status = "tool";
      messages.push({
        id: `event-${event.seq}`,
        role: "tool",
        text: lastTool,
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
      for (const partial of partials.values()) partial.streaming = false;
      partials.clear();
    }
  }
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
