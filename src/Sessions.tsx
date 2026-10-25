import {
  Check,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { sessionTitle } from "../shared/projection.mjs";
import { activeProgressItems, sessionCompletedAt } from "../shared/progress.mjs";
import { NewSession } from "./NewSession";
import { platformConnection, providerLabel } from "./platforms";
import type { AppState } from "./types";

export function Sessions({
  state,
  busy,
  error,
  run,
  onClose,
}: {
  state: AppState;
  busy: boolean;
  error: string;
  run: (action: string, payload?: any) => Promise<any>;
  onClose: () => void;
}) {
  const connected = state.connection === "connected";
  const active = state.sessions.filter((session) => session.running).length;
  // Sessions whose progress bubble is currently on screen; only those can be
  // closed here, so the list mirrors what the deck actually shows.
  const bubbled = new Set(
    activeProgressItems(state).map((item) => item.sessionId),
  );
  const sessions = [...state.sessions].sort(
    (a, b) => sessionCompletedAt(state, b) - sessionCompletedAt(state, a),
  );
  return (
    <section className="sessions-inline" role="region" aria-label="会话列表">
      <header className="sessions-heading">
        <div>
          <h2 id="sessions-title">切换会话</h2>
          <p>
            {state.sessions.length} 个会话
            {active ? ` · ${active} 个进行中` : ""}
          </p>
        </div>
        <button
          aria-label="刷新会话"
          className="icon-button"
          disabled={!connected || busy}
          onClick={() => run("refresh")}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
        </button>
        <button
          aria-label="关闭会话列表"
          className="icon-button"
          autoFocus
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <NewSession state={state} busy={busy} run={run} onCreated={onClose} />
      {state.sessions.some((session) => session.readOnly) && (
        <p className="session-source-hint">
          Codex 外部会话可查看已保存的内容，运行状态与操作请回到原窗口。
        </p>
      )}
      <div className="sessions-list">
        {state.pending.some(
          (item) =>
            !state.sessions.some(
              (session) => session.sessionId === item.sessionId,
            ),
        ) && (
          <div className="offline-banner">
            <CircleHelp size={16} />
            <span>有子代理正在等待回应，请在 DSH 中处理。</span>
            <button onClick={() => run("openDsh")}>
              打开 DSH
              <ExternalLink size={12} />
            </button>
          </div>
        )}
        {!state.sessions.length && (
          <div className="empty-sessions">
            <MessageCircle size={27} />
            <p>
              {connected
                ? "还没有会话，说说你的第一个想法吧。"
                : "连接后，这里会显示 DSH 和 Codex 的会话。"}
            </p>
          </div>
        )}
        {sessions.map((session) => {
          const count = state.pending.filter(
            (item) => item.sessionId === session.sessionId,
          ).length;
          const current = session.sessionId === state.selectedId;
          const title = sessionTitle(session);
          return (
            <div className="session-row" key={session.sessionId}>
              <button
                className={`session-card ${current ? "current" : ""}`}
                data-provider={session.provider || "dsh"}
                aria-current={current ? "true" : undefined}
                disabled={
                  busy ||
                  platformConnection(state, session.provider || "dsh").status !==
                    "connected"
                }
                onClick={async () => {
                  if (await run("select", session.sessionId)) onClose();
                }}
              >
                <span
                  className={`session-icon ${count ? "waiting" : session.running ? "running" : ""}`}
                >
                  {count ? (
                    <CircleHelp size={18} />
                  ) : session.running ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : (
                    <MessageCircle size={18} />
                  )}
                </span>
                <span className="session-card-text">
                  <strong>
                    <span
                      className={`provider-badge ${session.provider || "dsh"}`}
                    >
                      {providerLabel(session.provider || "dsh")}
                    </span>{" "}
                    {title}
                  </strong>
                  <span>
                    {session.cwd?.split(/[\\/]/).filter(Boolean).pop() ||
                      "未指定项目"}
                    <span className="middot">·</span>
                    {session.readOnly
                      ? "仅查看 · 外部会话"
                      : count
                        ? "等待你回应"
                        : session.running
                          ? "正在进行"
                          : session.blank
                            ? "新会话"
                            : new Date(session.updatedAt).toLocaleDateString(
                                "zh-CN",
                                { month: "short", day: "numeric" },
                              )}
                  </span>
                </span>
                {current && <Check size={15} />}
              </button>
              {bubbled.has(session.sessionId) && (
                <button
                  className="session-dismiss"
                  data-provider={session.provider || "dsh"}
                  disabled={busy}
                  aria-label={`关闭气泡：${title}`}
                  title={`关闭气泡显示：${title}（不会停止任务）`}
                  onClick={() => run("dismissProgress", session.sessionId)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
