import { sessionTitle } from "./projection.mjs";

const labels = {
  thinking: "正在思考",
  replying: "正在回复",
  learning: "正在读取资料",
  working: "正在执行工具",
  waiting: "等待你回应",
  error: "执行出错",
};

export function activeProgress(state) {
  if (
    state.config.progressBubbles === false ||
    state.connection !== "connected"
  )
    return null;
  const sessions = state.sessions.filter((item) => item.origin !== "subagent");
  const pending =
    state.pending.find(
      (item) =>
        item.sessionId === state.selectedId &&
        sessions.some((session) => session.sessionId === item.sessionId),
    ) ||
    state.pending.find((item) =>
      sessions.some((session) => session.sessionId === item.sessionId),
    );
  const running = sessions.filter((item) => item.running);
  const session = pending
    ? sessions.find((item) => item.sessionId === pending.sessionId)
    : running.find((item) => item.sessionId === state.selectedId) ||
      running.sort(
        (first, second) =>
          (state.activity[second.sessionId]?.at || 0) -
          (state.activity[first.sessionId]?.at || 0),
      )[0];
  if (!session) return null;
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
    running: running.length,
  };
}
