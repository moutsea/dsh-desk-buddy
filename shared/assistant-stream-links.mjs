import { randomUUID } from "node:crypto";

// DSH's cursorless stream and durable messages share ordering on the mux
// socket, but older hosts omit attemptId from the final event. Remember that
// association at the boundary; history reads must not guess it from prose.
export class AssistantStreamLinks {
  rows = new Map();
  generation = 0;
  row(id) {
    if (!this.rows.has(id))
      this.rows.set(id, {
        // Socket-local ordering floor, not evidence that the Session is empty.
        eventSeq: -1,
        stream: undefined,
        links: new Map(),
      });
    return this.rows.get(id);
  }
  key(event) {
    return JSON.stringify([event.seq, event.data?.turn, event.data?.step]);
  }
  enrich(row, event) {
    const link =
      event.type === "assistant/message" && row.links.get(this.key(event));
    if (
      !link ||
      (typeof event.data?.attemptId === "string" &&
        event.data.attemptId !== link.attemptId)
    )
      return event;
    return { ...event, data: { ...event.data, ...link } };
  }
  streamFrame(payload, stream) {
    return {
      ...payload,
      frame: {
        ...payload.frame,
        streamId: stream.streamId,
        ...(payload.frame.type === "start" && stream.afterSeq >= 0
          ? { afterSeq: stream.afterSeq }
          : {}),
      },
    };
  }
  history(id, events) {
    const row = this.row(id);
    // HTTP can observe the final before the mux delivers even its start.
    // Enrich known identities without advancing the socket's ordering cursor.
    return events.map((event) => this.enrich(row, event));
  }
  observe(payload) {
    const id = payload.sessionId;
    if (!id) return payload;
    if (
      payload.type === "host/session-removed" ||
      (payload.type === "session/history" && payload.reset)
    ) {
      this.rows.delete(id);
      return payload;
    }
    if (payload.type === "session/assistant-stream") {
      const frame = payload.frame;
      if (
        !Number.isSafeInteger(frame?.revision) ||
        typeof frame.attemptId !== "string"
      )
        return payload;
      const row = this.row(id),
        previous = row.stream;
      if (frame.type === "start") {
        if (
          previous?.id === frame.attemptId &&
          previous.turn === frame.turn &&
          previous.step === frame.step &&
          (previous.ended || frame.revision <= previous.revision)
        )
          return this.streamFrame(payload, previous);
        row.stream = {
          id: frame.attemptId,
          // Host attempt counters restart with an Agent, even if displayed
          // history survives a reconnect. Never use them as viewport IDs.
          streamId: `dsh-${randomUUID()}`,
          turn: frame.turn,
          step: frame.step,
          revision: frame.revision,
          afterSeq: row.eventSeq,
          bind: true,
          ended: false,
        };
        // HTTP may already contain this reply. Expose a start boundary only
        // after observing a durable event on this socket; a fresh connection
        // can join mid-turn and -1 must not make old HTTP history look newer.
        return this.streamFrame(payload, row.stream);
      } else if (
        previous?.id === frame.attemptId &&
        !previous.ended &&
        frame.revision > previous.revision
      ) {
        if (frame.type === "end") {
          previous.bind = frame.outcome?.kind === "committed";
          previous.ended = true;
        } else if (
          frame.type !== "chunk" ||
          frame.revision !== previous.revision + 1
        ) {
          previous.bind = false;
          previous.ended = true;
        }
        previous.revision = frame.revision;
      }
      if (previous?.id === frame.attemptId)
        return this.streamFrame(payload, previous);
    }
    if (payload.type === "session/event") {
      const row = this.row(id),
        event = payload.event;
      if (Number.isSafeInteger(event?.seq) && event.seq > row.eventSeq) {
        row.eventSeq = event.seq;
        if (event.type === "assistant/message") {
          const explicit = event.data?.attemptId;
          const stream = row.stream;
          const matches =
            stream?.bind &&
            event.seq > stream.afterSeq &&
            (stream.turn === undefined || event.data?.turn === stream.turn) &&
            (stream.step === undefined || event.data?.step === stream.step) &&
            (typeof explicit !== "string" || explicit === stream.id);
          const attemptId =
            typeof explicit === "string"
              ? explicit
              : matches
                ? stream.id
                : undefined;
          if (attemptId)
            row.links.set(this.key(event), {
              attemptId,
              ...(matches ? { streamId: stream.streamId } : {}),
            });
        }
        if (
          [
            "assistant/message",
            "assistant/attempt",
            "turn/start",
            "turn/end",
          ].includes(event.type) &&
          row.stream &&
          event.seq > row.stream.afterSeq
        ) {
          row.stream.bind = false;
          row.stream.ended = true;
        }
      }
      return { ...payload, event: this.enrich(row, event) };
    }
    return payload;
  }
  reset() {
    this.rows.clear();
    this.generation++;
  }
}
