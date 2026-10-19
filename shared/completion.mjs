import { endStatus } from "./activity.mjs";
import { sessionTitle } from "./projection.mjs";

export const COMPLETION_DURATION = 6000;

/** Only call for accepted live events; history never creates reminders.
 * @param {any[]} previous @param {string} sessionId @param {any} event */
export function recordCompletion(previous, sessionId, event, now = Date.now()) {
  if (
    !sessionId ||
    !Number.isSafeInteger(event?.seq) ||
    event.type !== "turn/end" ||
    endStatus(event.data?.reason) !== "done"
  )
    return previous;
  const id = `${sessionId}:${event.seq}`;
  if (previous.some((item) => item.id === id)) return previous;
  return [
    ...previous.filter((item) => now - item.at < COMPLETION_DURATION),
    { id, sessionId, at: now },
  ];
}

/** Completion feedback survives a new turn and a manually pinned expression.
 * @param {any} state */
export function activeCompletion(state, now = Date.now()) {
  if (state.connection !== "connected") return null;
  const sessions = new Map(
    state.sessions
      .filter((session) => session.origin !== "subagent")
      .map((session) => [session.sessionId, session]),
  );
  const active = (state.completions || []).filter(
    (item) =>
      sessions.has(item.sessionId) &&
      now >= item.at &&
      now - item.at < COMPLETION_DURATION,
  );
  const latest = active.at(-1);
  if (!latest) return null;
  return {
    id: latest.id,
    text:
      active.length > 1
        ? `${active.length} 个任务完成啦！`
        : `${sessionTitle(sessions.get(latest.sessionId))} 完成啦！`,
  };
}
