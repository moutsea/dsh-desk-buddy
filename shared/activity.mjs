// Live events drive reactions. History is deliberately never fed through this reducer.
export const ACTIVE_STATUSES = ["thinking", "learning", "working", "replying"];
export const REACTION_TIMES = {
  shock: 4000,
  celebration: 6000,
  happy: 12000,
  error: 20000,
  linger: 1400,
};

/** Classify names only, never infer tool success or intent from model prose. */
export function toolActivity(name = "") {
  const leaf = name.toLowerCase().split(/[.:/]/).pop();
  return /^(read|read_file|read_image|search|web_search|web_fetch|fetch|grep|glob|ls|list|list_files|find|lookup)$/.test(
    leaf,
  )
    ? "learning"
    : "working";
}
export function endStatus(reason) {
  const kind =
    typeof reason === "string" ? reason : reason?.kind || reason?.type;
  if (kind === "completed") return "done";
  if (/error|fail/i.test(kind || "")) return "error";
  if (/abort|cancel|interrupt/i.test(kind || "")) return "cancelled";
  return "blocked"; // Includes max-tokens and unknown extension reasons; only explicit success celebrates.
}
/** @param {any} previous @param {any} event */
export function reduceActivity(previous, event, now = Date.now()) {
  if (!Number.isSafeInteger(event?.seq) || event.seq <= (previous?.seq ?? -1))
    return previous;
  const data = event.data || {};
  let next = { ...previous, seq: event.seq };
  const tools = { ...previous?.tools };
  const set = (status, extra = {}) => {
    next = {
      ...next,
      status,
      at: previous?.status === status ? previous.at : now,
      ...extra,
    };
  };
  const remaining = () => {
    const entries = Object.values(tools);
    const status = entries.some((tool) => toolActivity(tool) === "working")
      ? "working"
      : "learning";
    set(entries.length ? status : "thinking", { tools, tool: entries.at(-1) });
  };
  if (event.type === "turn/start")
    next = { status: "thinking", seq: event.seq, at: now, tools: {} };
  if (event.type === "step/start" && !Object.keys(tools).length)
    set("thinking");
  if (event.type === "assistant/chunk" || event.type === "assistant/message") {
    const text =
      data.chunk?.type === "text-delta" ||
      data.message?.content?.some((b) => b.type === "text");
    if (!Object.keys(tools).length) set(text ? "replying" : "thinking");
  }
  if (event.type === "tool/call") {
    tools[data.callId || `seq-${event.seq}`] = data.name || "工具";
    remaining();
    next.linger = { mood: next.status, until: now + REACTION_TIMES.linger };
  }
  if (event.type === "tool/result") {
    const blocks = data.message?.content || [];
    const results = blocks.filter((block) => block.type === "tool-result");
    const ids = results.map((block) => block.toolCallId).filter(Boolean);
    if (ids.length) for (const id of ids) delete tools[id];
    else delete tools[Object.keys(tools)[0]];
    remaining();
    if (results.some((block) => block.isError === true) || data.error)
      next.reaction = {
        mood: "shocked",
        at: now,
        until: now + REACTION_TIMES.shock,
      };
  }
  if (event.type === "turn/end")
    next = {
      status: endStatus(data.reason),
      at: now,
      seq: event.seq,
      tools: {},
      message: data.reason?.error?.message,
    };
  return next;
}

/** Reconcile a host snapshot without erasing tool phases or replaying terminal reactions.
 * @param {any} activity */
export function reconcileActivity(activity, running, now = Date.now()) {
  if (running)
    return ACTIVE_STATUSES.includes(activity?.status)
      ? activity
      : { status: "thinking", at: now, seq: activity?.seq };
  return ACTIVE_STATUSES.includes(activity?.status)
    ? { status: "idle", seq: activity.seq }
    : activity;
}

/** @param {any} activity */
export function sessionMood(activity, running = false, now = Date.now()) {
  const age = now - (activity?.at ?? -Infinity);
  if (activity?.reaction?.until > now) return activity.reaction.mood;
  if (running) {
    if (
      activity?.linger?.until > now &&
      ["thinking", "replying"].includes(activity?.status)
    )
      return activity.linger.mood;
    return ACTIVE_STATUSES.includes(activity?.status)
      ? activity.status
      : "thinking";
  }
  if (activity?.status === "done" && age < REACTION_TIMES.celebration)
    return "celebrating";
  if (activity?.status === "done" && age < REACTION_TIMES.happy) return "done";
  if (activity?.status === "error" && age < REACTION_TIMES.shock)
    return "error";
  if (activity?.status === "error" && age < REACTION_TIMES.error)
    return "concerned";
  if (["cancelled", "blocked"].includes(activity?.status) && age < 6000)
    return activity.status;
  return "idle";
}

/** Global pet watches all ordinary sessions, including background work.
 * @param {any} state */
export function overallMood(state, now = Date.now()) {
  if (state.connection !== "connected") return "offline";
  if (state.pending.length) return "waiting";
  const rows = state.sessions
    .map((session) => ({
      ...session,
      activity: state.activity[session.sessionId],
      mood: sessionMood(
        state.activity[session.sessionId],
        session.running,
        now,
      ),
    }))
    .sort(
      (a, b) =>
        (b.activity?.reaction?.at || b.activity?.at || 0) -
        (a.activity?.reaction?.at || a.activity?.at || 0),
    );
  const urgent = rows.find((row) => ["error", "shocked"].includes(row.mood));
  if (urgent) return urgent.mood;
  const celebration = rows.find((row) => row.mood === "celebrating");
  if (celebration) return celebration.mood;
  const active = rows.find((row) => row.running);
  return (
    active?.mood || rows.find((row) => row.mood !== "idle")?.mood || "idle"
  );
}
