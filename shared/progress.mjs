import { sessionTitle } from "./projection.mjs";

const labels = {
  thinking: "正在思考",
  replying: "正在回复",
  learning: "正在读取资料",
  working: "正在执行工具",
  waiting: "等待你回应",
  error: "执行出错",
};

export function activeProgressItems(state) {
  if (
    state.config.progressBubbles === false ||
    state.connection !== "connected"
  )
    return [];
  const sessions = state.sessions.filter((item) => item.origin !== "subagent");
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
  ]);
  return [...ids].map((id) =>
    progressFor(state, byId.get(id), pending.get(id)),
  );
}

export function activeProgress(state) {
  return activeProgressItems(state)[0] || null;
}

function progressFor(state, session, pending) {
  const activity = state.activity[session.sessionId];
  const status = pending ? "waiting" : activity?.status || "thinking";
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
