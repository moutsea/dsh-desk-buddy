import { sessionTitle } from "./projection.mjs";

const labels = {
  thinking: "正在思考",
  replying: "正在回复",
  learning: "正在读取资料",
  working: "正在执行工具",
  waiting: "等待你回应",
  error: "执行出错",
  done: "已完成",
  cancelled: "已停止",
  blocked: "已暂停",
  idle: "本轮已结束",
};

const terminal = new Set(["done", "cancelled", "blocked", "error"]);

function finishEntry(entry, status, now) {
  if (status === "done" && entry.status !== "done") entry.completedAt = now;
  if (status !== "done") delete entry.completedAt;
  entry.status = status;
}

// Completion priority belongs to the finished turn, not to the session's
// metadata update time. A new turn or pending action immediately removes it.
export function sessionCompletedAt(state, session) {
  const entry = state.progressEntries?.[session.sessionId];
  return !session.running &&
    !entry?.active &&
    entry?.status === "done" &&
    !state.pending.some((item) => item.sessionId === session.sessionId)
    ? entry.completedAt || 0
    : 0;
}

function sessionReady(state, session) {
  const connection =
    state.connections?.[session.provider || "dsh"]?.status ?? state.connection;
  return connection === "connected" && session.runningKnown !== false;
}

// Track only work observed during this app run; browsing old history must not
// create bubbles. Visibility is independent of task execution and sound cues.
export class ProgressTracker {
  entries = new Map();
  knownTurns = new Map();
  remember(id, turn) {
    if (turn === undefined || turn === null) return;
    if (!this.knownTurns.has(id)) this.knownTurns.set(id, new Set());
    // DSH recovery has no ancestry marker: any previously observed turn can
    // become the head after rollback. Keep identities until prune/forget,
    // otherwise an old head would reopen dismissed work as a new completion.
    this.knownTurns.get(id).add(turn);
  }
  // New or resumed threads can finish before their metadata arrives. Keep
  // their lifecycle separate until a fresh list confirms an ordinary session.
  unresolved = new Map();
  start(id, turn, known = true, metadataRevision) {
    this.remember(id, turn);
    let entry = known ? this.entries.get(id) : this.unresolved.get(id)?.entry;
    if (!entry || !entry.active || (entry.turn !== null && entry.turn !== turn))
      entry = {
        active: true,
        hidden: false,
        turn,
        status: "idle",
      };
    else entry.turn = turn;
    if (known) {
      this.unresolved.delete(id);
      this.entries.set(id, entry);
    } else this.unresolved.set(id, { entry, metadataRevision });
  }
  end(id, status, now = Date.now()) {
    const entry = this.unresolved.get(id)?.entry;
    if (entry) {
      entry.active = false;
      finishEntry(entry, terminal.has(status) ? status : "idle", now);
    }
  }
  hasFreshMetadata(row, unresolved) {
    return (
      unresolved?.metadataRevision === undefined ||
      row.metadataRevision > unresolved.metadataRevision
    );
  }
  sync(state, now = Date.now()) {
    const pending = new Set(state.pending.map((item) => item.sessionId));
    for (const row of state.sessions) {
      // Reconnecting clears running for presentation before the next snapshot
      // arrives. That placeholder is not evidence that the task ended.
      if (row.origin === "subagent" || !sessionReady(state, row)) continue;
      const unresolved = this.unresolved.get(row.sessionId);
      if (unresolved && this.hasFreshMetadata(row, unresolved)) {
        this.unresolved.delete(row.sessionId);
        // Read-only means the runtime unloaded it, not that its observed task
        // never happened. Preserve completed work and its dismissal as well.
        this.entries.set(row.sessionId, unresolved.entry);
      }
      const active =
        !row.readOnly && (row.running || pending.has(row.sessionId));
      const turn = row.lastTurn;
      let entry = this.entries.get(row.sessionId);
      const changed =
        entry && entry.turn !== null && turn && entry.turn !== turn.key;
      // Source chronology/ancestry can identify rollback beyond our loaded
      // pages, including a revert whose notification was missed while offline.
      // Preserve completion/dismissal unless there is evidence of new work.
      if (
        entry &&
        !active &&
        ((turn?.historical && entry.turn !== turn.key) ||
          (changed && this.knownTurns.get(row.sessionId)?.has(turn.key)))
      ) {
        entry.active = false;
        continue;
      }
      if (turn) this.remember(row.sessionId, turn.key);
      if ((active && (!entry || !entry.active)) || changed) {
        entry = {
          active,
          hidden: false,
          turn: turn?.key ?? null,
          status: "idle",
        };
        this.entries.set(row.sessionId, entry);
      }
      if (!entry) continue;
      if (entry.turn === null && turn) entry.turn = turn.key;
      entry.active = active;
      // Verified history supplies the terminal state of changed/unloaded work.
      // Otherwise current activity (including a status-only task's idle state)
      // wins over an older turn's terminal snapshot.
      const status =
        (row.readOnly || changed) && terminal.has(turn?.status)
          ? turn.status
          : (state.activity[row.sessionId]?.status ?? turn?.status);
      if (!active && terminal.has(status)) finishEntry(entry, status, now);
    }
    return Object.fromEntries(
      [...this.entries].map(([id, entry]) => [id, { ...entry }]),
    );
  }
  dismiss(id) {
    for (const entry of [this.entries.get(id), this.unresolved.get(id)?.entry])
      if (entry) entry.hidden = true;
  }
  prune(sessions) {
    // Missing metadata is not a deletion: another provider may have refreshed
    // first. Explicit removal/reset uses forget() to clear unresolved records.
    for (const row of sessions)
      if (row.origin === "subagent") this.unresolved.delete(row.sessionId);
    const ids = new Set(sessions.map((row) => row.sessionId));
    for (const id of this.entries.keys())
      if (!ids.has(id)) this.entries.delete(id);
    for (const id of this.knownTurns.keys())
      if (!ids.has(id) && !this.unresolved.has(id)) this.knownTurns.delete(id);
  }
  forget(matches) {
    for (const entries of [this.entries, this.unresolved, this.knownTurns])
      for (const id of entries.keys()) if (matches(id)) entries.delete(id);
  }
}

export function activeProgressItems(state) {
  if (
    state.config.progressBubbles === false ||
    state.connection !== "connected"
  )
    return [];
  const sessions = state.sessions.filter(
    (item) =>
      item.origin !== "subagent" &&
      sessionReady(state, item) &&
      !state.progressEntries?.[item.sessionId]?.hidden &&
      (!item.readOnly || state.progressEntries?.[item.sessionId]),
  );
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const pending = new Map();
  for (const item of state.pending) {
    if (byId.has(item.sessionId) && !pending.has(item.sessionId))
      pending.set(item.sessionId, item);
  }
  const running = sessions.filter((item) => item.running);
  const ids = new Set([
    ...(pending.has(state.selectedId) ? [state.selectedId] : []),
    ...pending.keys(),
    ...running
      .filter((item) => item.sessionId === state.selectedId)
      .map((item) => item.sessionId),
    ...running
      .sort(
        (first, second) =>
          (state.activity[second.sessionId]?.at || 0) -
          (state.activity[first.sessionId]?.at || 0),
      )
      .map((item) => item.sessionId),
    ...sessions
      .filter((item) => state.progressEntries?.[item.sessionId])
      .map((item) => item.sessionId),
  ]);
  return [...ids]
    .map((id) => progressFor(state, byId.get(id), pending.get(id)))
    .sort((a, b) => b.completedAt - a.completedAt);
}

export function activeProgress(state) {
  return activeProgressItems(state)[0] || null;
}

function progressFor(state, session, pending) {
  const activity = state.activity[session.sessionId];
  const status = pending
    ? "waiting"
    : session.running
      ? activity?.status || "thinking"
      : state.progressEntries?.[session.sessionId]?.status ||
        (terminal.has(activity?.status) ? activity.status : "idle");
  const label = labels[status] || "正在执行";
  const text = pending
    ? pending.reason || pending.questions?.[0]?.question || label
    : (status === "error" ? activity?.message : "") ||
      (["working", "learning"].includes(status) ? activity?.toolSummary : "") ||
      (status === "replying"
        ? state.liveAssistant?.[session.sessionId]?.text || activity?.preview
        : "") ||
      label;
  const compact = text.replace(/\s+/g, " ").trim();
  return {
    sessionId: session.sessionId,
    completedAt: sessionCompletedAt(state, session),
    provider: session.provider || "dsh",
    title: sessionTitle(session),
    status,
    label,
    text:
      compact.length > 180
        ? status === "replying"
          ? `…${compact.slice(-180)}`
          : `${compact.slice(0, 180)}…`
        : compact,
  };
}
