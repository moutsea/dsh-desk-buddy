import type { AppState, Provider } from "./types";
export const providerLabel = (provider: Provider) =>
  provider === "codex" ? "Codex" : "DSH";
export function platformConnection(state: AppState, provider: Provider) {
  return (
    state.connections?.[provider] || {
      status:
        (state.config.provider || "dsh") === provider
          ? state.connection
          : "offline",
      message: state.connectionMessage,
      host: state.host,
    }
  );
}
export function selectedProvider(state: AppState): Provider {
  return (
    state.sessions.find((session) => session.sessionId === state.selectedId)
      ?.provider ||
    state.config.provider ||
    "dsh"
  );
}
