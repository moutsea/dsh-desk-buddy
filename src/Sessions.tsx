import {
  Check,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { sessionTitle } from "../shared/projection.mjs";
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
      <button
        className="new-session primary"
        disabled={!connected || busy}
        onClick={async () => {
          if (await run("create")) onClose();
        }}
      >
        <Plus size={15} />
        新建会话
      </button>
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
                : "连接后，这里会显示 DSH 中的会话。"}
            </p>
          </div>
        )}
        {state.sessions.map((session) => {
          const count = state.pending.filter(
            (item) => item.sessionId === session.sessionId,
          ).length;
          const current = session.sessionId === state.selectedId;
          return (
            <button
              className={`session-card ${current ? "current" : ""}`}
              key={session.sessionId}
              aria-current={current ? "true" : undefined}
              disabled={busy || !connected}
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
                <strong>{sessionTitle(session)}</strong>
                <span>
                  {session.cwd?.split(/[\\/]/).filter(Boolean).pop() ||
                    "未指定项目"}
                  <span className="middot">·</span>
                  {count
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
          );
        })}
      </div>
    </section>
  );
}
