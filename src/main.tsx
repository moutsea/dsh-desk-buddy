import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Folder,
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  X,
  WifiOff,
  SmilePlus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mascot } from "./Mascot";
import { Expressions } from "./Expressions";
import { Sessions } from "./Sessions";
import { PetSizeSetting } from "./PetSizeSetting";
import { PluginUpdates } from "./PluginUpdates";
import { usePetDrag, type PetDrag } from "./usePetDrag";
import {
  PET_CHARACTER,
  petSize,
  normalizePetScale,
  CHAT_SIZES,
  normalizeChatSize,
} from "../shared/desktop-layout.mjs";
import { version } from "../package.json";
import { MotionContext } from "./Motion";
import { chooseExpression } from "../shared/expressions.mjs";
import { overallMood, sessionMood } from "../shared/activity.mjs";
import { projectSession, sessionTitle } from "../shared/projection.mjs";
import { deepseekPricingPeriod } from "../shared/pricing-period.mjs";
import { activeCompletion } from "../shared/completion.mjs";
import { activeProgress } from "../shared/progress.mjs";
import type { AppState, Pending } from "./types";
import "./style.css";

const initial: AppState = {
  surface: {
    section: null,
    side: "left",
    pet: { x: 0, y: 0 },
    contentWidth: 0,
    contentHeight: 0,
    contentTop: 0,
  },
  connection: "offline",
  connectionMessage: "",
  host: null,
  sessions: [],
  selectedId: "",
  events: [],
  hasMore: false,
  pending: [],
  activity: {},
  completions: [],
  balance: null,
  balanceError: "",
  config: { endpoint: "http://127.0.0.1:3080", cwd: "", alwaysOnTop: true },
};
const labels: Record<string, string> = {
  offline: "未连接",
  connecting: "连接中",
  reconnecting: "重新连接中",
  connected: "已连接",
  idle: "在这里陪你",
  thinking: "正在思考",
  tool: "正在使用工具",
  working: "认真工作中",
  learning: "正在学习资料",
  replying: "正在和你说话",
  celebrating: "完成啦，庆祝一下！",
  shocked: "工具出错了，正在处理",
  concerned: "遇到问题，等你一起看看",
  waiting: "等你回应",
  done: "这一轮完成啦",
  cancelled: "当前轮次已停止",
  error: "这一轮遇到问题",
  blocked: "这一轮暂停了",
};
const invoke = async (action: string, payload?: any) => {
  if (!window.desktop) throw new Error("请在桌面应用中连接 DSH");
  return window.desktop.invoke(action, payload);
};
function useDesktop() {
  const [ready, setReady] = useState(!window.desktop);
  const [state, setState] = useState(initial);
  const [surface, setSurface] = useState(initial.surface);
  useEffect(() => {
    if (!window.desktop) return;
    let live = true;
    const unsubscribe = window.desktop.subscribe((value) => {
      if (live) {
        setReady(true);
        setState(value);
        setSurface(value.surface);
      }
    });
    const unsubscribeSurface = window.desktop.subscribeSurface?.((value) => {
      if (live) setSurface(value);
    });
    window.desktop.invoke("state").then((value) => {
      if (live) {
        setReady(true);
        setState(value);
        setSurface(value.surface);
      }
    });
    return () => {
      live = false;
      unsubscribe();
      unsubscribeSurface?.();
    };
  }, []);
  return { state, surface, ready };
}
function balanceLabel(state: AppState) {
  if (!state.balance) return "未连接";
  const first = state.balance.balances[0];
  return `${first.currency === "CNY" ? "¥" : "$"}${first.total.toFixed(2)}${state.balanceError || state.connection !== "connected" || Date.now() - state.balance.updatedAt > 120000 ? " · 旧数据" : ""}${state.balance.balances.length > 1 ? " +" : ""}`;
}
function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return now;
}
function Pet({ state, drag }: { state: AppState; drag: PetDrag }) {
  const size = petSize(state.config.petScale),
    scale = normalizePetScale(state.config.petScale) / 100;
  const now = useClock();
  const pricingPeriod = deepseekPricingPeriod(now);
  const [menuOpen, setMenuOpen] = useState(false);
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reveal = () => {
    if (dismiss.current) clearTimeout(dismiss.current);
    setMenuOpen(true);
  };
  const conceal = () => {
    if (dismiss.current) clearTimeout(dismiss.current);
    dismiss.current = setTimeout(() => setMenuOpen(false), 240);
  };
  const [interaction, setInteraction] = useState<{
    id: string;
    until: number;
  } | null>(null);
  const [idle, setIdle] = useState({ id: "idle", until: 0 });
  const lastActive = useRef(Date.now()),
    nextIdle = useRef(Date.now() + 28000 + Math.random() * 20000);
  const clicks = useRef<number[]>([]),
    hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIdle = useRef("");
  const call = (action: string, payload?: any) => {
    void invoke(action, payload).catch(() => {});
  };
  const mood = overallMood(state, now),
    running = state.sessions.filter((item) => item.running).length;
  const completion = activeCompletion(state, now);
  const progress = state.surface.section ? null : activeProgress(state);
  const celebrate =
    !!completion && !["offline", "waiting", "error", "shocked"].includes(mood);
  useEffect(() => {
    return () => {
      if (hover.current) clearTimeout(hover.current);
      if (dismiss.current) clearTimeout(dismiss.current);
    };
  }, []);
  useEffect(() => {
    if (mood !== "idle") lastActive.current = Date.now();
    if (state.lastInteractionAt)
      lastActive.current = Math.max(
        lastActive.current,
        state.lastInteractionAt,
      );
    nextIdle.current = Date.now() + 28000 + Math.random() * 20000;
    setIdle({ id: "idle", until: 0 });
  }, [mood, state.lastInteractionAt]);
  useEffect(() => {
    if (
      mood !== "idle" ||
      (state.config.expression && state.config.expression !== "auto") ||
      state.config.idleExpressions === false ||
      now < nextIdle.current
    )
      return;
    const pool = ["rice", "proud", "cheer", "happy", "learning"].filter(
      (id) => id !== lastIdle.current,
    );
    const id = pool[Math.floor(Math.random() * pool.length)];
    lastIdle.current = id;
    setIdle({ id, until: now + 7000 });
    nextIdle.current = now + 28000 + Math.random() * 20000;
  }, [now, mood, state.config.expression, state.config.idleExpressions]);
  const activity = () => {
    lastActive.current = Date.now();
    nextIdle.current = Date.now() + 28000 + Math.random() * 20000;
    setIdle((current) =>
      current.id === "idle" ? current : { id: "idle", until: 0 },
    );
  };
  const quietFor = now - lastActive.current;
  const idleExpression =
    state.config.idleExpressions === false
      ? "idle"
      : quietFor > 240000
        ? "sleeping"
        : quietFor > 120000
          ? "sleepy"
          : quietFor > 60000
            ? "bored"
            : idle.until > now
              ? idle.id
              : "idle";
  const expression = chooseExpression({
    selection: state.config.expression,
    taskMood: mood,
    interaction,
    idleExpression,
    now,
  });
  const reactionText: Record<string, string> = {
    love: "嘿，我在呢 ♡",
    angry: "慢一点啦，哼！",
    shy: "一直看着我做什么呀…",
  };
  const showReaction =
    (!state.config.expression || state.config.expression === "auto") &&
    ["idle", "done"].includes(mood) &&
    interaction &&
    interaction.until > now;
  const controlsVisible = menuOpen && !drag.dragging;
  return (
    <div
      className={`pet-stage ${controlsVisible ? "menu-open" : ""} ${drag.dragging ? "is-dragging" : ""}`}
      style={{ width: size.width, height: size.height }}
      onMouseLeave={conceal}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) conceal();
      }}
    >
      {progress && (
        <button
          data-interactive
          className={`pet-progress-bubble ${progress.status}`}
          aria-label={`查看进度：${progress.title}`}
          title="点击打开对应对话"
          onClick={() => call("openSession", progress.sessionId)}
        >
          <span className="progress-heading">
            <span className={`status-dot ${progress.status}`} />
            <strong>{progress.title}</strong>
            <ChevronRight size={13} aria-hidden="true" />
          </span>
          <span className="progress-preview">{progress.text}</span>
          <span className="progress-footer">
            {progress.label}
            {progress.running > 1 && ` · ${progress.running} 个会话进行中`}
          </span>
        </button>
      )}
      <div
        className="pet-hover-controls"
        inert={!controlsVisible}
        aria-hidden={!controlsVisible}
        onMouseEnter={reveal}
        onFocus={reveal}
      >
        <div className="pet-menu" aria-label="桌宠功能">
          {[
            { id: "chat", name: "对话", icon: MessageCircle },
            { id: "expressions", name: "表情", icon: SmilePlus },
            { id: "settings", name: "设置", icon: Settings2 },
          ].map((item) => (
            <button
              key={item.id}
              data-interactive
              className={`pet-orb ${state.surface.section === item.id ? "selected" : ""}`}
              aria-label={item.name}
              aria-pressed={state.surface.section === item.id}
              onClick={() =>
                call(
                  "section",
                  state.surface.section === item.id ? null : item.id,
                )
              }
            >
              <item.icon size={16} strokeWidth={1.7} />
              {item.name}
              {item.id === "chat" && state.pending.length > 0 && (
                <span className="orb-count">{state.pending.length}</span>
              )}
            </button>
          ))}
        </div>
        <button
          data-interactive
          className={`pet-balance ${state.balanceError ? "stale" : ""}`}
          aria-label={`DeepSeek 余额 ${balanceLabel(state)} · 当前${pricingPeriod.label}`}
          title={[
            `DeepSeek 余额 ${balanceLabel(state)}`,
            state.balanceError,
            pricingPeriod.description,
            "点击查看 DeepSeek Key 账号余额详情",
          ]
            .filter(Boolean)
            .join("\n")}
          onClick={() => call("section", "settings")}
        >
          <span className="pet-balance-label">DeepSeek 余额</span>
          <span className="pet-balance-value">{balanceLabel(state)}</span>
          <span className={`pet-pricing-period ${pricingPeriod.id}`}>
            {pricingPeriod.label}
          </span>
        </button>
      </div>
      <button
        data-interactive
        className="pet-character"
        style={{
          top: PET_CHARACTER.top,
          left: (size.width - PET_CHARACTER.width * scale) / 2,
          width: PET_CHARACTER.width * scale,
          height: PET_CHARACTER.height * scale,
        }}
        aria-label="摸摸桌宠"
        title="按住拖动 · 点击摸摸 · 右键切换表情"
        onPointerDown={(event) => {
          drag.onPointerDown(event);
          if (hover.current) clearTimeout(hover.current);
          activity();
        }}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
        onLostPointerCapture={drag.onLostPointerCapture}
        onDragStart={(event) => event.preventDefault()}
        onFocus={reveal}
        onMouseEnter={() => {
          reveal();
          activity();
          if (hover.current) clearTimeout(hover.current);
          if (!drag.held)
            hover.current = setTimeout(
              () => setInteraction({ id: "shy", until: Date.now() + 5000 }),
              8000,
            );
        }}
        onMouseLeave={() => {
          if (hover.current) clearTimeout(hover.current);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          activity();
          call("expressionMenu");
        }}
        onClick={(event) => {
          if (drag.preventClick(event)) return;
          const time = Date.now();
          activity();
          clicks.current = [
            ...clicks.current.filter((value) => time - value < 1800),
            time,
          ];
          setInteraction({
            id: clicks.current.length >= 5 ? "angry" : "love",
            until: time + 6000,
          });
        }}
      >
        <div
          className={`pet-completion-action ${celebrate && !drag.dragging && state.config.animations !== false ? "is-celebrating" : ""}`}
        >
          <Mascot
            mood={celebrate ? "celebrating" : mood}
            expression={celebrate ? "celebrating" : expression}
          />
        </div>
      </button>
      {completion && (
        <div
          className="pet-completion-notice"
          role="status"
          title={completion.text}
        >
          <Check size={12} aria-hidden="true" />
          <span>{completion.text}</span>
        </div>
      )}
      <div
        className="pet-caption"
        aria-hidden={!controlsVisible || !!completion}
      >
        <span className={`status-dot ${mood}`} />
        {showReaction
          ? reactionText[interaction.id]
          : running > 1
            ? `${running} 个会话进行中`
            : labels[mood]}
      </div>
    </div>
  );
}
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <span className="text-link" title={href}>
            {children}
          </span>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
function Interaction({
  item,
  run,
  disabled,
}: {
  item: Pending;
  run: (action: string, payload?: any) => Promise<any>;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<
    Record<string, { selected: string[]; custom: string }>
  >({});
  return (
    <div className="interaction">
      <div className="interaction-title">
        {item.type === "approval/requested" ? (
          <ShieldCheck size={16} />
        ) : (
          <CircleHelp size={16} />
        )}
        <strong>
          {item.type === "approval/requested" ? "需要你的许可" : "有件事想问你"}
        </strong>
      </div>
      {item.type === "approval/requested" ? (
        <>
          <p className="tool-name">{item.toolName}</p>
          {item.reason && <p>{item.reason}</p>}
          <div className="button-row">
            <button
              disabled={disabled}
              className="secondary"
              onClick={() =>
                run("answer", { rpcId: item.rpcId, outcome: "rejected" })
              }
            >
              拒绝
            </button>
            <button
              disabled={disabled}
              className="primary"
              onClick={() =>
                run("answer", { rpcId: item.rpcId, outcome: "allowed-once" })
              }
            >
              允许一次
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run("answer", {
              rpcId: item.rpcId,
              answers: item.questions?.map((question) => ({
                id: question.id,
                selected: answers[question.id]?.selected || [],
                ...(answers[question.id]?.custom.trim()
                  ? { custom: answers[question.id].custom.trim() }
                  : {}),
              })),
            });
          }}
        >
          {item.questions?.map((question) => (
            <fieldset key={question.id}>
              <legend>{question.question}</legend>
              {question.detail && (
                <div className="question-detail">
                  <Markdown text={question.detail} />
                </div>
              )}
              {question.options?.map((option) => {
                const current = answers[question.id] || {
                  selected: [],
                  custom: "",
                };
                return (
                  <label className="option" key={option.label}>
                    <input
                      disabled={disabled}
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={question.id}
                      checked={current.selected.includes(option.label)}
                      onChange={() =>
                        setAnswers({
                          ...answers,
                          [question.id]: {
                            selected: question.multiSelect
                              ? current.selected.includes(option.label)
                                ? current.selected.filter(
                                    (label) => label !== option.label,
                                  )
                                : [...current.selected, option.label]
                              : [option.label],
                            custom: question.multiSelect ? current.custom : "",
                          },
                        })
                      }
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                  </label>
                );
              })}
              <input
                disabled={disabled}
                className="text-input"
                placeholder="或输入你的回答"
                value={answers[question.id]?.custom || ""}
                onChange={(event) =>
                  setAnswers({
                    ...answers,
                    [question.id]: {
                      selected: question.multiSelect
                        ? answers[question.id]?.selected || []
                        : [],
                      custom: event.target.value,
                    },
                  })
                }
              />
            </fieldset>
          ))}
          <button
            className="primary"
            disabled={
              disabled ||
              item.questions?.some(
                (q) =>
                  !answers[q.id]?.selected.length &&
                  !answers[q.id]?.custom.trim(),
              )
            }
          >
            提交回答
          </button>
        </form>
      )}
    </div>
  );
}
function Panel({ state }: { state: AppState }) {
  const now = useClock();
  const lastEngagement = useRef(0);
  const engage = () => {
    if (Date.now() - lastEngagement.current < 1000) return;
    lastEngagement.current = Date.now();
    void invoke("engage").catch(() => {});
  };
  const tab = state.surface.section || "chat";
  const setTab = (section: string) => {
    void invoke("section", section);
  };
  const [sessionsOpen, setSessionsOpen] = useState(false),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [endpoint, setEndpoint] = useState(state.config.endpoint),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    previous = useRef(""),
    busyRef = useRef(false),
    olderHeight = useRef(0);
  const connected = state.connection === "connected",
    selected = state.sessions.find(
      (item) => item.sessionId === state.selectedId,
    ),
    pending = state.pending.filter(
      (item) => item.sessionId === state.selectedId,
    );
  const projection = projectSession(state.events, !!selected?.running);
  const live = state.liveAssistant?.[state.selectedId];
  if (live?.text && selected?.running)
    projection.messages.push({
      id: `live-${live.attemptId}`,
      role: "assistant",
      text: live.text,
      streaming: true,
    });
  const status = pending.length
    ? "waiting"
    : state.activity[state.selectedId]?.status || projection.status;
  const mood = !connected
    ? "offline"
    : pending.length
      ? "waiting"
      : sessionMood(state.activity[state.selectedId], !!selected?.running, now);
  const expression = chooseExpression({
    selection: state.config.expression,
    taskMood: mood,
    now,
  });
  const draftKey = state.selectedId || "new",
    draft = drafts[draftKey] || "";
  const active = state.sessions.filter((item) => item.running).length;
  const setDraft = (value: string) =>
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));
  useEffect(() => setEndpoint(state.config.endpoint), [state.config.endpoint]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(id);
  }, [notice]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (!projection.messages.length) {
      scroll.current.scrollTop = 0;
      previous.current = state.selectedId;
      return;
    }
    if (olderHeight.current) {
      scroll.current.scrollTop +=
        scroll.current.scrollHeight - olderHeight.current;
      olderHeight.current = 0;
      return;
    }
    if (previous.current !== state.selectedId || follow.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    previous.current = state.selectedId;
  }, [
    state.events,
    state.selectedId,
    tab,
    state.surface.section,
    state.pending,
    sessionsOpen,
  ]);
  async function run(action: string, payload?: any) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      return await invoke(action, payload);
    } catch (err) {
      olderHeight.current = 0;
      setError(
        (err as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (!draft.trim() || busyRef.current || !connected) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const key = draftKey,
      text = draft.trim();
    try {
      if (!state.selectedId) await invoke("create");
      const result = await invoke("send", text);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
      if (result) setNotice(result);
      else if (selected?.running) setNotice("消息已加入 DSH 队列");
      follow.current = true;
    } catch (err) {
      setError(
        (err as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ) + "。草稿已保留；网络异常时请先查看历史，避免重复发送。",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="app-shell"
      onPointerDown={engage}
      onKeyDown={(event) => {
        engage();
        if (event.key === "Escape") {
          event.preventDefault();
          if (sessionsOpen) setSessionsOpen(false);
          else void invoke("section", null);
        }
      }}
    >
      <header className="titlebar">
        <div className="surface-title">
          {tab === "chat" ? (
            <MessageCircle size={17} />
          ) : tab === "expressions" ? (
            <SmilePlus size={17} />
          ) : (
            <Settings2 size={17} />
          )}
          <strong>
            {tab === "chat" ? "对话" : tab === "expressions" ? "表情" : "设置"}
          </strong>
          <span>dsh-desk-buddy</span>
        </div>
        <div className="window-actions">
          <button
            aria-label="打开 DSH"
            title="在浏览器中打开 DSH"
            onClick={() => run("openDsh")}
          >
            <ExternalLink size={14} />
          </button>
          <button aria-label="收起内容" onClick={() => invoke("section", null)}>
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="connection-strip">
        <span className={`status-dot ${connected ? "connected" : "offline"}`} />
        <span>{labels[state.connection]}</span>
        {state.host && (
          <span className="host-version">DSH {state.host.version}</span>
        )}
        <span className="connection-right">
          {active ? `${active} 个会话进行中` : "你的桌面小搭档"}
        </span>
      </div>
      {error && (
        <div role="alert" className="alert error">
          <span>{error}</span>
          <button aria-label="关闭提示" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="alert notice">
          {notice}
        </div>
      )}
      {!connected && tab !== "settings" && (
        <div className="offline-banner">
          <WifiOff size={16} />
          <span>
            {state.connectionMessage || "连接本机 DSH，开始第一段对话。"}
          </span>
          <button onClick={() => setTab("settings")}>
            去连接
            <ChevronRight size={12} />
          </button>
        </div>
      )}
      {tab === "chat" && (
        <>
          <div className="conversation-bar">
            <div className="conversation-companion">
              <div className="conversation-avatar">
                <Mascot small mood={mood} expression={expression} />
              </div>
              <div className="conversation-copy">
                <span className="eyebrow">当前会话</span>
                <button
                  className="session-trigger"
                  aria-label="切换会话"
                  aria-expanded={sessionsOpen}
                  title="查看和切换已有会话"
                  onClick={() => setSessionsOpen((open) => !open)}
                >
                  <strong>
                    {selected ? sessionTitle(selected) : "从一个想法开始"}
                  </strong>
                  <ChevronDown size={14} />
                </button>
                <span
                  className={`conversation-mood ${mood}`}
                  aria-live="polite"
                >
                  {labels[mood]}
                </span>
              </div>
            </div>
            <button
              className="icon-button"
              aria-label="新建会话"
              title="在所选项目中新建会话"
              disabled={!connected || busy}
              onClick={() => run("create")}
            >
              <Plus size={18} />
            </button>
          </div>
          {state.pending.some(
            (item) => item.sessionId !== state.selectedId,
          ) && (
            <button
              className="other-pending"
              onClick={() => setSessionsOpen(true)}
            >
              <CircleHelp size={14} />
              其他会话有待回应事项
              <ChevronRight size={13} />
            </button>
          )}
          {sessionsOpen && (
            <Sessions
              state={state}
              busy={busy}
              error={error}
              run={run}
              onClose={() => setSessionsOpen(false)}
            />
          )}
          <div className="chat-body" hidden={sessionsOpen}>
            <div
              className="messages"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current;
                if (el)
                  follow.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 75;
              }}
            >
              {state.hasMore && (
                <button
                  className="load-older"
                  disabled={busy}
                  onClick={() => {
                    olderHeight.current = scroll.current?.scrollHeight || 0;
                    run("older");
                  }}
                >
                  加载更早的消息
                </button>
              )}
              {!projection.messages.length && (
                <div className="welcome">
                  <div className="welcome-mascot">
                    <Mascot small />
                  </div>
                  <span className="eyebrow">
                    A LITTLE COMPANY, A LITTLE MAGIC
                  </span>
                  <h1>你好呀，我是 dsh-desk-buddy。</h1>
                  <p>说说你的想法，我们一起把它做好。</p>
                  <div className="suggestions">
                    {["先看看这个项目", "梳理一下接下来要做什么"].map(
                      (text) => (
                        <button key={text} onClick={() => setDraft(text)}>
                          {text}
                          <ChevronRight size={13} />
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}
              {projection.messages.map((message: any) =>
                message.role === "tool" ? (
                  <details className="tool-message" key={message.id}>
                    <summary>
                      <span className="tool-dot" />
                      <span className="tool-copy">
                        <strong>{message.name}</strong>
                        {message.detail && <code>{message.detail}</code>}
                      </span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </summary>
                    <pre>{message.arguments || "此调用没有参数"}</pre>
                  </details>
                ) : (
                  <article
                    key={message.id}
                    className={`message ${message.role}`}
                  >
                    <div className="message-label">
                      {message.role === "user" ? (
                        "你"
                      ) : (
                        <>
                          <span className="mini-spark">✳</span> dsh-desk-buddy
                        </>
                      )}
                      {message.streaming && (
                        <span className="streaming-label">正在回复</span>
                      )}
                    </div>
                    <div className="message-content">
                      <Markdown text={message.text} />
                      {message.streaming && <span className="text-cursor" />}
                    </div>
                  </article>
                ),
              )}
              {state.activity[state.selectedId]?.message && (
                <div className="alert error">
                  {state.activity[state.selectedId].message}
                </div>
              )}
              {selected && status !== "idle" && (
                <div className={`task-status ${status}`}>
                  {selected.running ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Check size={13} />
                  )}
                  <span>
                    {labels[status] || "执行状态已更新"}
                    {["tool", "working", "learning"].includes(status) &&
                    state.activity[state.selectedId]?.tool
                      ? ` · ${state.activity[state.selectedId].tool}`
                      : ""}
                  </span>
                </div>
              )}
              {pending.map((item) => (
                <Interaction
                  key={item.rpcId}
                  item={item}
                  run={run}
                  disabled={busy || !connected}
                />
              ))}
            </div>
            <div className="composer-area">
              <div className="project-row">
                <Folder size={13} />
                <span title={selected?.cwd || state.config.cwd}>
                  {selected?.cwd || state.config.cwd || "先选择一个项目目录"}
                </span>
                <button disabled={busy} onClick={() => run("pickDirectory")}>
                  {selected ? "新会话目录" : "选择目录"}
                </button>
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <textarea
                  aria-label="消息"
                  placeholder={
                    connected
                      ? selected?.running
                        ? "补充你的想法，将加入消息队列…"
                        : "有什么想一起做的？"
                      : "先连接 DSH，然后开始对话…"
                  }
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={100000}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-footer">
                  <span className="permission-label">
                    <ShieldCheck size={12} />
                    使用 DSH 当前权限
                  </span>
                  <div>
                    {selected?.running && (
                      <button
                        type="button"
                        className="stop-button"
                        aria-label="停止当前轮次"
                        title="取消当前轮次，保留 DSH 排队消息"
                        disabled={busy || !connected}
                        onClick={() => run("cancel")}
                      >
                        <Square size={13} fill="currentColor" />
                      </button>
                    )}
                    <button
                      className="send-button"
                      aria-label="发送消息"
                      disabled={busy || !connected || !draft.trim()}
                    >
                      {busy ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <ArrowUp size={19} />
                      )}
                    </button>
                  </div>
                </div>
              </form>
              <div className="composer-hint">
                Enter 发送 <span>·</span> Shift + Enter 换行 <span>·</span>{" "}
                执行中可继续补充
              </div>
            </div>
          </div>
        </>
      )}
      {tab === "expressions" && (
        <Expressions
          state={state}
          mood={overallMood(state, now)}
          busy={busy}
          run={run}
        />
      )}
      {tab === "settings" && (
        <div className="page-content settings-page">
          <div className="page-heading">
            <div>
              <span className="eyebrow">MAKE YOURSELF AT HOME</span>
              <h1>和桌面连接</h1>
            </div>
            <Settings2 size={24} strokeWidth={1.3} />
          </div>
          <PluginUpdates />
          <PetSizeSetting
            scale={normalizePetScale(state.config.petScale)}
            onApply={async (next) => {
              setError("");
              try {
                await invoke("petScale", next);
              } catch (err) {
                setError(
                  (err as Error).message.replace(
                    /^Error invoking remote method '[^']+': Error: /,
                    "",
                  ),
                );
              }
            }}
          />
          <section className="settings-card">
            <h2>对话框大小</h2>
            <p>默认使用「小」，调整后重启也会记住。空间不足时自动适应屏幕。</p>
            <div
              className="chat-size-options"
              role="group"
              aria-label="对话框大小"
            >
              {Object.entries(CHAT_SIZES).map(([size, option]) => (
                <button
                  key={size}
                  className={`secondary ${normalizeChatSize(state.config.chatSize) === size ? "current" : ""}`}
                  aria-pressed={
                    normalizeChatSize(state.config.chatSize) === size
                  }
                  disabled={busy}
                  onClick={() => void run("chatSize", size)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>
          <section className="settings-card">
            <div className="toggle-row">
              <div>
                <h2>执行进度气泡</h2>
                <p>收起窗口时，在桌宠上方显示最新进展，点击打开对应对话。</p>
              </div>
              <button
                role="switch"
                aria-checked={state.config.progressBubbles !== false}
                aria-label="执行进度气泡"
                className={`switch ${state.config.progressBubbles !== false ? "on" : ""}`}
                disabled={busy}
                onClick={() =>
                  run("progressBubbles", state.config.progressBubbles === false)
                }
              >
                <span />
              </button>
            </div>
          </section>
          <section className="settings-card">
            <h2>
              <span
                className={`status-dot ${connected ? "connected" : "offline"}`}
              />
              DSH 服务
            </h2>
            <p>
              {state.managed
                ? "由 DSH 插件启动，已自动配置当前服务。"
                : "连接你电脑上的 DSH，复用会话、工具与项目。"}
            </p>
            <label className="field-label" htmlFor="endpoint">
              本机服务地址
            </label>
            <input
              id="endpoint"
              className="text-input"
              value={endpoint}
              readOnly={state.managed}
              onChange={(event) => setEndpoint(event.target.value)}
              spellCheck={false}
            />
            <div className="button-row">
              <span className="muted">
                {state.host
                  ? `版本 ${state.host.version}`
                  : state.managed
                    ? "由插件自动连接"
                    : "默认端口 3080"}
              </span>
              <button
                className="primary"
                disabled={busy || state.connection === "connecting"}
                onClick={() => run("connect", endpoint)}
              >
                {busy || state.connection === "connecting" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Check size={14} />
                )}
                连接
              </button>
            </div>
            {state.connectionMessage && (
              <p className="connection-explanation">
                {state.connectionMessage}
              </p>
            )}
            {!state.managed && (
              <details>
                <summary>如何启动服务</summary>
                <code>dsh web --host 127.0.0.1 --port 3080 --no-open</code>
                <p>
                  先在终端启动 DSH Web，再点击连接。桌宠目前不管理 DSH 进程。
                </p>
              </details>
            )}
          </section>
          <section className="settings-card balance-card">
            <div className="section-title">
              <h2>DeepSeek 余额</h2>
              <button
                aria-label="刷新余额"
                className="icon-button"
                disabled={!connected || busy}
                onClick={() => run("balance")}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {state.balance ? (
              <>
                <div className="balance-values">
                  {state.balance.balances.map((row) => (
                    <strong key={row.currency}>
                      <span>{row.currency === "CNY" ? "¥" : "$"}</span>
                      {row.total.toFixed(2)}
                      <small>{row.currency}</small>
                    </strong>
                  ))}
                </div>
                <span className="muted">
                  DeepSeek Key 账号 ·{" "}
                  {new Date(state.balance.updatedAt).toLocaleTimeString(
                    "zh-CN",
                    { hour: "2-digit", minute: "2-digit" },
                  )}
                  {state.balanceError ? " · 旧数据" : " 更新"}
                </span>
              </>
            ) : (
              <div className="no-balance">
                —<span>等待余额数据</span>
              </div>
            )}
            {state.balanceError && (
              <p className="connection-explanation">{state.balanceError}</p>
            )}
            <details>
              <summary>连接余额插件</summary>
              <p>
                安装项目中的 dsh-girl-bridge 插件后重启 DSH。凭证在 DSH
                中配置，桌宠不读取密钥。具体步骤见项目 README。
              </p>
            </details>
          </section>
          <section className="settings-card">
            <div className="toggle-row">
              <div>
                <h2>始终在手边</h2>
                <p>桌宠和身旁的内容保持置顶</p>
              </div>
              <button
                role="switch"
                aria-checked={state.config.alwaysOnTop}
                aria-label="窗口置顶"
                className={`switch ${state.config.alwaysOnTop ? "on" : ""}`}
                onClick={() => run("alwaysOnTop", !state.config.alwaysOnTop)}
              >
                <span />
              </button>
            </div>
            <div className="setting-divider" />
            <div className="project-setting">
              <Folder size={16} />
              <div>
                <strong>新对话的项目</strong>
                <p title={state.config.cwd}>
                  {state.config.cwd || "还没有选择"}
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => run("pickDirectory")}
              >
                选择
              </button>
            </div>
          </section>
          <div className="settings-footnote">
            ⌘ / Ctrl + Shift + Space 快速唤起
            <br />
            dsh-desk-buddy · {version} · 一个轻轻陪着你的对话入口
          </div>
        </div>
      )}
    </div>
  );
}
document.body.dataset.view = "desktop";
document.title = "dsh-desk-buddy · 桌宠";
const ContentPanel = React.memo(Panel);
function App() {
  const { state, surface, ready } = useDesktop();
  const drag = usePetDrag();
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const passthrough = useRef<boolean | null>(null);
  const setPassthrough = (ignore: boolean) => {
    if (passthrough.current === ignore) return;
    passthrough.current = ignore;
    void invoke("passthrough", ignore).catch(() => {
      passthrough.current = null;
    });
  };
  useEffect(() => {
    setPassthrough(true);
  }, []);
  useLayoutEffect(() => {
    passthrough.current = null;
    const target =
      pointer.current &&
      document.elementFromPoint(pointer.current.x, pointer.current.y);
    setPassthrough(
      !drag.held &&
        !target?.closest("[data-interactive], .companion-surface.open"),
    );
  }, [surface, state.config.petScale, drag.held, ready]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        void invoke("section", null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  const size = petSize(state.config.petScale),
    scale = normalizePetScale(state.config.petScale) / 100;
  return (
    <MotionContext.Provider value={state.config.animations !== false}>
      <div
        className="desktop-stage"
        data-side={surface.side}
        style={{ visibility: ready ? "visible" : "hidden" }}
        onMouseMove={(event) => {
          pointer.current = { x: event.clientX, y: event.clientY };
          setPassthrough(
            !drag.held &&
              !(event.target as Element).closest(
                "[data-interactive], .companion-surface.open",
              ),
          );
        }}
        onMouseLeave={() => {
          pointer.current = null;
          setPassthrough(!drag.held);
        }}
      >
        <div
          className={`companion-surface ${surface.section ? "open" : ""}`}
          data-section={surface.section || undefined}
          inert={!surface.section}
          aria-hidden={!surface.section}
          style={
            {
              left:
                surface.side === "left"
                  ? surface.pet.x - surface.contentWidth - 18
                  : surface.pet.x + size.width + 18,
              top: surface.contentTop,
              width: surface.contentWidth,
              height: surface.contentHeight,
              "--tail-y": `${surface.pet.y + PET_CHARACTER.top + 95 * scale - surface.contentTop}px`,
            } as React.CSSProperties
          }
        >
          <ContentPanel state={state} />
        </div>
        <div
          className="pet-position"
          style={{
            left: surface.pet.x,
            top: surface.pet.y,
            width: size.width,
            height: size.height,
          }}
        >
          <Pet state={state} drag={drag} />
        </div>
      </div>
    </MotionContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
