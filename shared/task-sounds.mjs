import { endStatus } from "./activity.mjs";

export const TASK_SOUND_DURATION = 6000;

// Host errors have RPC identities, but no turn ID linking them to turn/end.
// Pair at most one host/terminal report within the turn boundary; never
// deduplicate by sticky error status alone. Remember RPCs separately from cues.
export class TaskSoundRecorder {
  constructor() {
    this.connectionEpoch = null;
    this.hostErrors = new Set();
    this.failures = new Map();
  }

  record(
    previous,
    sessionId,
    event,
    now = Date.now(),
    connectionEpoch = 0,
    continuingFailure = false,
  ) {
    if (this.connectionEpoch !== connectionEpoch) {
      this.connectionEpoch = connectionEpoch;
      this.hostErrors.clear();
      this.failures.clear();
    }
    const next = recordTaskSound(
      previous,
      sessionId,
      event,
      now,
      connectionEpoch,
    );
    if (next === previous) return previous;
    const host = event.type === "host/agent-error";
    if (host) {
      const key = JSON.stringify([sessionId, event.id]);
      if (this.hostErrors.has(key)) return previous;
      this.hostErrors.add(key);
      if (this.hostErrors.size > 512)
        this.hostErrors.delete(this.hostErrors.values().next().value);
    }
    if (
      !host &&
      (event.type === "turn/start" || endStatus(event.data?.reason) !== "error")
    ) {
      this.failures.delete(sessionId);
      return next;
    }
    const prior = this.failures.get(sessionId);
    const message = host ? event.message : event.data?.reason?.error?.message;
    this.failures.delete(sessionId);
    if (
      prior &&
      // Mux output may arrive after the host error and change activity status.
      // A new turn/start or non-error turn/end clears this pair above; output
      // does not. A later host error still needs the recovery guard because it
      // can belong to a new setup attempt before that attempt has a turn/start.
      (!host || continuingFailure) &&
      prior.host !== host &&
      now >= prior.at &&
      now - prior.at < TASK_SOUND_DURATION &&
      (!prior.message || !message || prior.message === message)
    )
      return previous;
    this.failures.set(sessionId, { host, message, at: now });
    if (this.failures.size > 100)
      this.failures.delete(this.failures.keys().next().value);
    return next;
  }
}

// Record accepted live transitions only. History and running-state snapshots
// must not create task-start or failure announcements.
export function recordTaskSound(
  previous,
  sessionId,
  event,
  now = Date.now(),
  connectionEpoch = 0,
) {
  if (!sessionId) return previous;
  const hostError = event?.type === "host/agent-error";
  if (
    hostError
      ? typeof event.id !== "string" || !event.id
      : !Number.isSafeInteger(event?.seq) ||
        !["turn/start", "turn/end"].includes(event.type)
  )
    return previous;
  const kind =
    event.type === "turn/start"
      ? "started"
      : hostError || endStatus(event.data?.reason) === "error"
        ? "failure"
        : null;
  const id = `${connectionEpoch}:${sessionId}:${hostError ? `host:${event.id}` : event.seq}:${kind}`;
  if (previous.some((item) => item.id === id)) return previous;
  const next = previous.filter(
    (item) =>
      item.sessionId !== sessionId &&
      now >= item.at &&
      now - item.at < TASK_SOUND_DURATION,
  );
  if (kind) next.push({ id, kind, sessionId, at: now });
  return next.slice(-100);
}
