import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  globalShortcut,
  dialog,
  shell,
} from "electron";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEndpoint } from "../shared/dsh-client.mjs";
import { normalizeCodexEndpoint } from "../shared/codex-client.mjs";
import {
  SessionClients,
  sessionSource,
  sessionKey,
  PROVIDERS,
} from "../shared/session-clients.mjs";
import { mergeEvents } from "../shared/projection.mjs";
import {
  MAX_HISTORY_EVENTS,
  setAssistantStream,
  setHistoryEvents,
} from "./history-state.mjs";
import { SessionProjections } from "../shared/session-projections.mjs";
import { EXPRESSIONS, isExpressionId } from "../shared/expressions.mjs";
import {
  reduceActivity,
  reconcileActivity,
  reconcileSessionActivity,
} from "../shared/activity.mjs";
import { ProgressTracker } from "../shared/progress.mjs";
import { recordCompletion } from "../shared/completion.mjs";
import { TaskSoundRecorder } from "../shared/task-sounds.mjs";
import {
  normalizeSoundSettings,
  patchSoundSettings,
} from "../shared/sound.mjs";
import { managedLaunch, managedControl } from "./managed.mjs";
import { PluginUpdates } from "./plugin-updates.mjs";
import { createTrayIcon } from "./tray-icon.mjs";
import { createBalanceRefresher } from "./balance.mjs";
import { HistoryReloads } from "./history-reloads.mjs";
import {
  desktopLayout,
  PET_SCALE,
  normalizePetScale,
  normalizeChatSize,
  petSize,
  resizedPetAnchor,
} from "../shared/desktop-layout.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const managed = managedLaunch();
const pluginUpdates = new PluginUpdates(
  managed?.managerEndpoint,
  app.getVersion(),
);
let controller;
app.setName("dsh-desk-buddy");
const dataDirectory =
  process.env.DEEPSEEK_GIRL_DATA_DIR || process.env.DSH_GIRL_DATA_DIR;
app.setPath(
  "userData",
  dataDirectory || join(app.getPath("appData"), "DeepSeek Girl"),
);
if (!app.requestSingleInstanceLock()) app.exit(0);
let pet,
  tray,
  quitting = false,
  saveTimer,
  pollTimer,
  balanceTimer,
  pointerTimer,
  broadcastTimer;
const client = new SessionClients();
const progressTracker = new ProgressTracker();
const historyReloads = new HistoryReloads();
let historyRevision = 0,
  snapshotRevision = 0;
const controlSnapshots = new Map();
const projections = new Map();
const hostRefreshes = new Map();
function scheduleHostRefresh(provider) {
  if (hostRefreshes.has(provider)) return;
  const timer = setTimeout(() => {
    hostRefreshes.delete(provider);
    refreshSessions(client, false, provider).catch(() => {});
  }, 500);
  timer.unref?.();
  hostRefreshes.set(provider, timer);
}
const taskSoundRecorders = new Map(
  PROVIDERS.map((provider) => [provider, new TaskSoundRecorder()]),
);
function projectionFor(id) {
  if (!projections.has(id)) projections.set(id, new SessionProjections());
  return projections.get(id);
}
let config = {
  endpoint: "http://127.0.0.1:3080",
  provider: "dsh",
  codexEndpoint: "ws://127.0.0.1:4500",
  cwd: "",
  selectedId: "",
  alwaysOnTop: true,
  petPosition: null,
  expression: "auto",
  idleExpressions: true,
  animations: true,
  petScale: PET_SCALE.default,
  chatSize: "small",
  progressBubbles: true,
  sounds: normalizeSoundSettings(null),
};
let state = {
  managed: !!managed,
  connections: client.connections(),
  connection: "offline",
  connectionEpoch: 0,
  connectionMessage: "",
  host: null,
  sessions: [],
  selectedId: "",
  events: [],
  eventsRevision: 0,
  liveAssistant: {},
  hasMore: false,
  pending: [],
  activity: {},
  completions: [],
  taskSounds: [],
  surface: {
    section: null,
    side: "left",
    pet: { x: 0, y: 0 },
    contentWidth: 0,
    contentHeight: 0,
    contentTop: 0,
  },
  lastInteractionAt: Date.now(),
  balance: null,
  balanceError: "",
  config,
};
const configPath = () => join(app.getPath("userData"), "settings.json");
function setEvents(events, hasMore = state.hasMore) {
  setHistoryEvents(state, events, hasMore);
}
const windows = () => [pet].filter((window) => window && !window.isDestroyed());
function broadcast() {
  state.historyReload = historyReloads.snapshot(state.selectedId);
  state.progressEntries = progressTracker.sync(state);
  controller?.send({
    type: "status",
    connection: state.connection,
    visible:
      !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(),
  });
  // Coalesce into a fixed window: continuous streams must not defer delivery.
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    // History is the largest part of the snapshot. Send it only when it
    // changed; the renderer keeps the last copy across status-only updates.
    const payload = { ...state };
    if (state.eventsRevision === sentEventsRevision) delete payload.events;
    sentEventsRevision = state.eventsRevision;
    windows().forEach((window) =>
      window.webContents.send("desktop:state", payload),
    );
  }, 35);
}
let saveQueue = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = JSON.stringify(config, null, 2);
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(configPath()), { recursive: true });
        await writeFile(configPath() + ".tmp", data);
        await rename(configPath() + ".tmp", configPath());
      })
      .catch(() => {
        state.connectionMessage = "设置暂时无法保存";
        broadcast();
      });
  }, 250);
}
function petAnchor() {
  const bounds = pet.getBounds();
  return {
    x: bounds.x + state.surface.pet.x,
    y: bounds.y + state.surface.pet.y,
  };
}
let arranging = false;
let petDrag = null;
let layoutBounds;
let ignoringMouse = false;
let sentEventsRevision = -1;
function setPassthrough(ignore) {
  if (ignoringMouse === ignore) return;
  ignoringMouse = ignore;
  pet.setIgnoreMouseEvents(ignore, { forward: true });
}
function cursorOverPanel() {
  const surface = state.surface;
  if (!surface.section) return false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = pet.getBounds();
  const left =
    bounds.x +
    (surface.side === "left"
      ? surface.pet.x - surface.contentWidth - 18
      : surface.pet.x + petSize(config.petScale).width + 18);
  const top = bounds.y + surface.contentTop;
  return (
    cursor.x >= left &&
    cursor.x < left + surface.contentWidth &&
    cursor.y >= top &&
    cursor.y < top + surface.contentHeight
  );
}
function applyLayout(layout, fullState = false) {
  const changed =
    JSON.stringify(state.surface) !== JSON.stringify(layout.surface);
  state.surface = layout.surface;
  arranging = true;
  if (fullState) {
    sentEventsRevision = state.eventsRevision;
    pet.webContents.send("desktop:state", state);
  } else if (changed) pet.webContents.send("desktop:surface", state.surface);
  if (
    !layoutBounds ||
    Object.keys(layout.bounds).some(
      (key) => layoutBounds[key] !== layout.bounds[key],
    )
  ) {
    pet.setBounds(layout.bounds);
    layoutBounds = layout.bounds;
  }
  arranging = false;
}
function finishPetDrag() {
  if (!petDrag || !pet || pet.isDestroyed()) return;
  petDrag = null;
  config.petPosition = petAnchor();
  save();
  broadcast();
}
function validDragPoint(point) {
  if (
    !point ||
    typeof point.x !== "number" ||
    typeof point.y !== "number" ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  )
    throw new Error("无效的拖动位置");
  return point;
}
function showSection(section, anchor, { reveal = true } = {}) {
  if (!pet || pet.isDestroyed()) return;
  anchor ||= petAnchor();
  const area = screen.getDisplayMatching({
    ...anchor,
    ...petSize(config.petScale),
  }).workArea;
  const layout = desktopLayout(
    anchor,
    area,
    section,
    config.petScale,
    config.chatSize,
  );
  applyLayout(layout, true);
  config.petPosition = petAnchor();
  save();
  if (reveal) {
    setPassthrough(false);
    if (section) {
      pet.show();
      pet.focus();
    } else pet.showInactive();
  }
  broadcast();
}
function toggleContent() {
  showSection(state.surface.section ? null : "chat");
}
function load(window, view) {
  const developmentUrl =
    process.env.DEEPSEEK_GIRL_DEV_URL || process.env.DSH_GIRL_DEV_URL;
  if (developmentUrl) window.loadURL(`${developmentUrl}/?view=${view}`);
  else window.loadFile(join(root, "dist/index.html"), { query: { view } });
}
function createWindow(options, view) {
  const window = new BrowserWindow({
    ...options,
    webPreferences: {
      preload: join(root, "electron/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  for (const event of ["show", "hide", "minimize", "restore"])
    window.on(event, () => {
      window.webContents.send(
        "desktop:visibility",
        window.isVisible() && !window.isMinimized(),
      );
      broadcast();
    });
  load(window, view);
  return window;
}
function createWindows() {
  const area = screen.getPrimaryDisplay().workArea;
  const stored = config.petPosition;
  const size = petSize(config.petScale);
  const position =
    stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
      ? stored
      : {
          x: area.x + area.width - size.width - 10,
          y: area.y + area.height - size.height - 10,
        };
  const layout = desktopLayout(
    position,
    screen.getDisplayMatching({ ...position, ...size }).workArea,
    null,
    config.petScale,
    config.chatSize,
  );
  state.surface = layout.surface;
  layoutBounds = layout.bounds;
  pet = createWindow(
    {
      ...layout.bounds,
      frame: false,
      transparent: true,
      // Opaque default backgrounds flash white whenever the compositor redraws
      // a transparent window, which happens on every fast session update.
      backgroundColor: "#00000000",
      acceptFirstMouse: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: config.alwaysOnTop,
      skipTaskbar: true,
      title: "dsh-desk-buddy · 桌宠",
      show: false,
    },
    "pet",
  );
  pet.once("ready-to-show", () => pet.showInactive());
  pointerTimer = setInterval(() => {
    if (ignoringMouse && pet.isVisible() && cursorOverPanel())
      setPassthrough(false);
  }, 40);
  pointerTimer.unref();
  pet.on("moved", () => {
    if (arranging || petDrag) return;
    config.petPosition = petAnchor();
    save();
  });
  pet.on("blur", finishPetDrag);
  pet.webContents.on("render-process-gone", finishPetDrag);
  pet.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      pet.hide();
    }
  });
  // Display changes reposition the existing surface without changing whether
  // the user hid it or stealing focus from another application.
  const reflow = () =>
    showSection(state.surface.section, undefined, { reveal: false });
  screen.on("display-removed", reflow);
  screen.on("display-metrics-changed", reflow);
  tray = new Tray(createTrayIcon());
  tray.setToolTip("dsh-desk-buddy");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "对话", click: () => showSection("chat") },
      { label: "表情", click: () => showSection("expressions") },
      { label: "设置", click: () => showSection("settings") },
      { label: "显示桌宠", click: () => pet.showInactive() },
      { label: "隐藏桌宠", click: () => pet.hide() },
      { type: "separator" },
      { label: "退出 dsh-desk-buddy", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleContent);
  if (!globalShortcut.register("CommandOrControl+Shift+Space", toggleContent)) {
    state.connectionMessage = "全局快捷键被占用，可从托盘打开对话";
  }
}
async function refreshSessions(
  expectedClient = client,
  poll = false,
  provider,
) {
  if (!expectedClient) return;
  const result = await expectedClient.rpc("session.list", { poll, provider });
  if (client !== expectedClient) return;
  if (!Array.isArray(result?.items))
    throw new Error("无法识别服务返回的会话列表");
  // Publish list readiness with its rows; a connected stream can still be
  // waiting for its first successful refresh after a connection reset.
  state.connections = expectedClient.connections();
  // Ordinary forks remain writable; only agent-owned subagents use another API.
  state.sessions = result.items
    .filter((item) => item.origin !== "subagent")
    .map((item) => {
      const store = projectionFor(item.sessionId);
      store.list(item.projections);
      item.projections = store.snapshot();
      return item;
    });
  // Include excluded subagent metadata so provisional work can be rejected;
  // read-only ordinary sessions may contain tasks that just finished unloading.
  progressTracker.prune(result.items);
  for (const row of state.sessions) {
    state.activity[row.sessionId] = reconcileSessionActivity(
      state.activity[row.sessionId],
      row,
    );
  }
  if (
    !state.selectedId &&
    state.sessions.some((item) => item.sessionId === config.selectedId)
  ) {
    state.selectedId = config.selectedId;
    setEvents([]);
    state.hasMore = false;
    historyRevision++;
    // A background list can recover after the startup reads already failed.
    // Keep the restored chat pending until its history loads, including retries.
    historyReloads.invalidate(state.selectedId);
  }
  if (
    state.selectedId &&
    !state.sessions.some((item) => item.sessionId === state.selectedId)
  ) {
    state.selectedId = "";
    setEvents([]);
    state.hasMore = false;
    historyRevision++;
  }
  broadcast();
}
async function history(older = false, expectedClient = client, requestId) {
  const id = state.selectedId;
  if (
    !id ||
    !expectedClient ||
    state.connections[sessionSource(id).provider].status !== "connected"
  )
    return;
  const revision = historyRevision;
  // Paging backwards does not recover missing messages at the newest end.
  const reload = older ? undefined : historyReloads.begin(id);
  const afterSeq = reload?.afterSeq ?? state.events.at(-1)?.seq;
  let committed = false,
    failure = "";
  const current = () =>
    client === expectedClient &&
    id === state.selectedId &&
    revision === historyRevision;
  try {
    const beforeSeq = older ? state.events[0]?.seq : undefined;
    const store = projectionFor(id);
    const seedProjections = store.beginSeed(++snapshotRevision);
    let result = await expectedClient.rpc("session.history", {
      sessionId: id,
      maxMessages: 40,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    if (!current()) return;
    if (!Array.isArray(result?.events))
      throw new Error("无法识别服务返回的会话历史");
    const replace = result.replace;
    const pages = [result.events];
    const snapshots = result.projections ? [result.projections] : [];
    let firstSeq = result.events[0]?.event?.seq;
    // DSH returns only the newest page. Walk backwards to the retained tail
    // before publishing anything, so a failed intermediate page remains
    // retryable and cannot leave an inaccessible hole in the rendered history.
    while (
      !older &&
      !replace &&
      afterSeq !== undefined &&
      result.hasMore &&
      (firstSeq ?? Infinity) > afterSeq
    ) {
      if (!Number.isSafeInteger(firstSeq))
        throw new Error("会话历史分页未能推进，请重试");
      const cursor = firstSeq;
      result = await expectedClient.rpc("session.history", {
        sessionId: id,
        maxMessages: 40,
        beforeSeq: cursor,
      });
      if (!current()) return;
      if (!Array.isArray(result?.events))
        throw new Error("无法识别服务返回的会话历史");
      firstSeq = result.events[0]?.event?.seq;
      if (
        result.replace ||
        (result.events.length
          ? !Number.isSafeInteger(firstSeq) || firstSeq >= cursor
          : result.hasMore)
      )
        throw new Error("会话历史分页未能推进，请重试");
      pages.push(result.events);
      if (result.projections) snapshots.push(result.projections);
    }
    const incoming = pages
      .reverse()
      .flatMap((page) => page.map((entry) => entry.event));
    const previousHead = state.events[0]?.seq ?? Infinity;
    const hasMore =
      replace ||
      (incoming[0]?.seq ?? Infinity) <= previousHead ||
      (older && beforeSeq === state.events[0]?.seq)
        ? result.hasMore
        : state.hasMore;
    setEvents(
      replace ? incoming : mergeEvents(state.events, incoming),
      hasMore,
    );
    if (snapshots.length) {
      const row = state.sessions.find((item) => item.sessionId === id);
      for (const snapshot of snapshots) seedProjections(snapshot);
      if (row) row.projections = store.snapshot();
    }
    committed = true;
    if (older && requestId) {
      state.historyPage = { requestId, sessionId: id };
      return { sessionId: id, eventsRevision: state.eventsRevision };
    }
  } catch (error) {
    // Revert/selection already replaced this read. Its failure must not leak
    // into the current chat or turn a successful replacement into an error.
    if (!current()) return;
    failure = error.message;
    throw error;
  } finally {
    historyReloads.finish(id, reload, { success: committed, error: failure });
    if (committed || reload) broadcast();
  }
}
const refreshBalance = createBalanceRefresher({ client, state, broadcast });
function handleFrame(frame) {
  const payload = frame.payload,
    id = payload.sessionId;
  const row = state.sessions.find((item) => item.sessionId === id);
  if (payload.type === "session/history") {
    if (payload.reset) {
      delete state.liveAssistant[id];
      historyReloads.invalidate(id);
      for (const turn of payload.previousTurns || [])
        progressTracker.remember(id, turn);
    }
    if (id === state.selectedId) {
      setEvents(payload.events, payload.hasMore);
      if (payload.reset) {
        historyRevision++;
        void history().catch(() => {});
      }
    }
  }
  if (payload.type === "session/assistant-stream") {
    const previousStream = state.liveAssistant[id];
    setAssistantStream(state, id, payload.frame);
    if (
      state.liveAssistant[id] &&
      state.liveAssistant[id] !== previousStream &&
      payload.frame?.chunk?.type === "text-delta" &&
      row?.running
    )
      state.activity[id] = {
        ...state.activity[id],
        status: "replying",
        at: Date.now(),
      };
  }
  if (payload.type === "session/event") {
    const event = payload.event;
    if (id === state.selectedId && !payload.activityOnly)
      setEvents(mergeEvents(state.events, [event]));
    const previous = state.activity[id];
    const activity = reduceActivity(previous, event);
    state.activity[id] = activity;
    // Ignore duplicate/reordered events for reactions AND running flags.
    if (activity === previous) return broadcast();
    activity.metadataRevision = row?.metadataRevision;
    activity.turn =
      payload.lastTurn?.key ??
      (event.data?.turn !== undefined
        ? JSON.stringify(event.data.turn)
        : previous?.turn);
    // A resumed read-only row still belongs to the old metadata snapshot.
    // Promote its new turn only after a fresh list verifies the subscription.
    if (row && !row.readOnly && payload.lastTurn)
      row.lastTurn = payload.lastTurn;
    if (
      [
        "assistant/message",
        "assistant/attempt",
        "turn/end",
        "turn/start",
      ].includes(event.type)
    )
      delete state.liveAssistant[id];
    state.completions = recordCompletion(
      state.completions,
      id,
      event,
      Date.now(),
      frame.epoch ?? state.connectionEpoch,
    );
    state.taskSounds = taskSoundRecorders
      .get(payload.provider || "dsh")
      .record(
        state.taskSounds,
        id,
        event,
        Date.now(),
        frame.epoch ?? state.connectionEpoch,
        previous?.status === "error",
      );
    if (event.type === "turn/start") {
      if (row) {
        row.running = true;
        row.runningKnown = true;
      }
      if (row?.origin !== "subagent")
        progressTracker.start(
          id,
          payload.lastTurn?.key ??
            (event.data?.turn !== undefined
              ? JSON.stringify(event.data.turn)
              : `${frame.epoch ?? state.connectionEpoch}:${event.seq}`),
          !!row && !row.readOnly,
          row?.metadataRevision,
        );
    }
    if (event.type === "turn/end") {
      progressTracker.end(id, activity.status);
      if (row) {
        row.running = false;
        row.runningKnown = true;
      }
      if (id === state.selectedId) history().catch(() => {});
    }
  }
  if (payload.type === "host/session-status") {
    if (row) {
      row.running = payload.running;
      row.runningKnown = true;
    }
    state.activity[id] = reconcileActivity(state.activity[id], payload.running);
  }
  if (payload.type === "host/agent-error") {
    state.taskSounds = taskSoundRecorders
      .get(payload.provider || "dsh")
      .record(
        state.taskSounds,
        id,
        { type: payload.type, id: frame.rpcId, message: payload.message },
        Date.now(),
        frame.epoch ?? state.connectionEpoch,
        state.activity[id]?.status === "error",
      );
    state.activity[id] = {
      ...state.activity[id],
      status: "error",
      tools: {},
      toolDetails: {},
      toolSummary: "",
      preview: "",
      reaction: { mood: "shocked", at: Date.now(), until: Date.now() + 4000 },
      message: payload.message,
      at: Date.now(),
    };
  }
  if (
    payload.type === "host/session-added" ||
    payload.type === "host/session-removed" ||
    payload.type === "host/session-invalidated"
  )
    scheduleHostRefresh(payload.provider);
  if (payload.type === "host/session-removed") {
    historyReloads.forget((sessionId) => sessionId === id);
    projections.delete(id);
    state.sessions = state.sessions.filter((row) => row.sessionId !== id);
    progressTracker.forget((sessionId) => sessionId === id);
    delete state.activity[id];
    delete state.liveAssistant[id];
    state.pending = state.pending.filter((item) => item.sessionId !== id);
    state.completions = state.completions.filter(
      (item) => item.sessionId !== id,
    );
    state.taskSounds = state.taskSounds.filter((item) => item.sessionId !== id);
    if (state.selectedId === id) {
      state.selectedId = "";
      config.selectedId = "";
      setEvents([]);
      state.hasMore = false;
      historyRevision++;
      save();
    }
    broadcast();
  }
  if (payload.type === "session/projections") {
    for (const [sessionId, block] of Object.entries(
      payload.projections || {},
    )) {
      const store = projectionFor(sessionId);
      store.seed(block, controlSnapshots.get(payload.provider) || 0);
      const session = state.sessions.find(
        (item) => item.sessionId === sessionId,
      );
      if (session) session.projections = store.snapshot();
    }
  }
  if (payload.type === "session/projection" && typeof id === "string") {
    const store = projectionFor(id);
    store.apply(payload.key, payload.value, payload.seq);
    if (row) row.projections = store.snapshot();
  }
  if (
    payload.type === "approval/requested" ||
    payload.type === "question/requested"
  ) {
    if (!state.pending.some((item) => item.rpcId === frame.rpcId))
      state.pending.push({ ...payload, rpcId: frame.rpcId });
  }
  if (payload.type === "approval/resolved")
    state.pending = state.pending.filter(
      (item) => item.approvalId !== payload.approvalId,
    );
  if (payload.type === "question/resolved")
    state.pending = state.pending.filter(
      (item) => item.rpcId !== payload.questionRpcId,
    );
  broadcast();
}
function updateConnections() {
  state.connections = client.connections();
  const rows = Object.values(state.connections);
  const next = rows.some((row) => row.status === "connected")
    ? "connected"
    : rows.some((row) => row.status === "connecting")
      ? "connecting"
      : rows.some((row) => row.status === "reconnecting")
        ? "reconnecting"
        : "offline";
  if (state.connection === "connected" && next !== "connected")
    state.connectionEpoch++;
  state.connection = next;
  const provider = state.selectedId
    ? sessionSource(state.selectedId).provider
    : config.provider;
  state.host = state.connections[provider]?.host || null;
  state.connectionMessage = state.connections[provider]?.message || "";
  broadcast();
}
client.on("status", updateConnections);
client.on("stream-start", ({ kind, provider }) => {
  if (kind === "mux") controlSnapshots.set(provider, ++snapshotRevision);
});
client.on("frame", handleFrame);
client.on("reset", ({ provider, removeSessions }) => {
  const belongs = (id) =>
    typeof id === "string" && sessionSource(id).provider === provider;
  state.pending = state.pending.filter((item) => item.provider !== provider);
  for (const values of [state.activity, state.liveAssistant])
    for (const id of Object.keys(values)) if (belongs(id)) delete values[id];
  for (const id of projections.keys()) if (belongs(id)) projections.delete(id);
  state.completions = state.completions.filter(
    (item) => !belongs(item.sessionId),
  );
  state.taskSounds = state.taskSounds.filter(
    (item) => !belongs(item.sessionId),
  );
  state.sessions = state.sessions.flatMap((row) =>
    belongs(row.sessionId)
      ? removeSessions
        ? []
        : [
            {
              ...row,
              running: false,
              runningKnown: false,
              lastTurn: undefined,
              projections: undefined,
            },
          ]
      : [row],
  );
  if (removeSessions) {
    progressTracker.forget(belongs);
    historyReloads.forget(belongs);
  }
  if (state.selectedId && belongs(state.selectedId)) {
    historyRevision++;
    if (removeSessions) {
      state.selectedId = "";
      setEvents([]);
      state.hasMore = false;
    } else {
      // Keep the displayed history during automatic reconnect, but require a
      // current read to fill the gap. A failed ready-time read must retry.
      historyReloads.invalidate(state.selectedId, state.events.at(-1)?.seq);
    }
  }
  if (provider === "dsh" && removeSessions) {
    state.balance = null;
    state.balanceError = "";
  }
  updateConnections();
});
client.on("ready", ({ provider }) => {
  updateConnections();
  // DSH's describe RPC can finish before its event streams are connected.
  // Fetch balance when the platform is usable, including after reconnects.
  if (provider === "dsh") void refreshBalance();
  refreshSessions(client, false, provider)
    .then(() =>
      state.selectedId && sessionSource(state.selectedId).provider === provider
        ? history()
        : undefined,
    )
    .catch(() => {});
});
async function connect(
  endpoint,
  provider = config.provider,
  chooseDefault = true,
) {
  if (!PROVIDERS.includes(provider)) throw new Error("未知服务类型");
  endpoint =
    provider === "codex"
      ? normalizeCodexEndpoint(endpoint)
      : normalizeEndpoint(endpoint);
  const previous =
    provider === "codex" ? config.codexEndpoint : config.endpoint;
  const host = await client.connect(provider, endpoint, {
    token: provider === "dsh" ? managed?.token : undefined,
  });
  if (!host || client.entries.get(provider)?.host !== host) return;
  if (provider === "codex") config.codexEndpoint = endpoint;
  else config.endpoint = endpoint;
  config.enabledProviders = [
    ...new Set([...(config.enabledProviders || []), provider]),
  ];
  if (
    chooseDefault &&
    !state.selectedId &&
    !Object.entries(state.connections).some(
      ([source, row]) => source !== provider && row.status === "connected",
    )
  )
    config.provider = provider;
  if (
    previous !== endpoint &&
    config.selectedId &&
    sessionSource(config.selectedId).provider === provider
  )
    config.selectedId = "";
  save();
  if (!config.cwd) {
    config.cwd = host.cwd;
    save();
  }
  await refreshSessions(client, false, provider);
  if (state.selectedId && sessionSource(state.selectedId).provider === provider)
    await history();
  updateConnections();
}
function requireClient(id = state.selectedId, provider = config.provider) {
  client.require(id ? sessionSource(id).provider : provider);
  return client;
}
function setExpression(value) {
  if (value !== "auto" && !isExpressionId(value)) throw new Error("未知表情");
  config.expression = value;
  save();
  broadcast();
}
ipcMain.handle("desktop:action", async (event, action, payload) => {
  if (!windows().some((window) => window.webContents === event.sender))
    throw new Error("未知窗口");
  switch (action) {
    case "state":
      return state;
    case "pluginUpdateStatus":
      return pluginUpdates.request();
    case "checkPluginUpdate":
      return pluginUpdates.request("checkUpdate");
    case "installPluginUpdate":
      return pluginUpdates.request("installUpdate", payload);
    case "visibility": {
      const window = BrowserWindow.fromWebContents(event.sender);
      return window.isVisible() && !window.isMinimized();
    }
    case "cursorPosition": {
      const window = BrowserWindow.fromWebContents(event.sender);
      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getContentBounds();
      const zoom = event.sender.getZoomFactor();
      return {
        x: (cursor.x - bounds.x) / zoom,
        y: (cursor.y - bounds.y) / zoom,
      };
    }
    case "engage":
      state.lastInteractionAt = Date.now();
      broadcast();
      return;
    case "expression":
      return setExpression(payload);
    case "idleExpressions":
      if (typeof payload !== "boolean") throw new Error("无效设置");
      config.idleExpressions = payload;
      save();
      broadcast();
      return;
    case "animations":
      if (typeof payload !== "boolean") throw new Error("无效设置");
      config.animations = payload;
      save();
      broadcast();
      return;
    case "dismissProgress":
      if (typeof payload !== "string") throw new Error("无效会话");
      progressTracker.dismiss(payload);
      broadcast();
      return;
    case "progressBubbles":
      if (typeof payload !== "boolean") throw new Error("无效设置");
      config.progressBubbles = payload;
      save();
      broadcast();
      return;
    case "soundSettings":
      config.sounds = patchSoundSettings(config.sounds, payload);
      save();
      broadcast();
      return config.sounds;
    case "expressionMenu": {
      const groups = [...new Set(EXPRESSIONS.map((item) => item.group))];
      const menu = Menu.buildFromTemplate([
        {
          label: "自动跟随会话",
          type: "checkbox",
          checked: config.expression === "auto",
          click: () => setExpression("auto"),
        },
        { type: "separator" },
        ...groups.map((group) => ({
          label: group,
          submenu: EXPRESSIONS.filter((item) => item.group === group).map(
            (item) => ({
              label: item.label,
              type: "checkbox",
              checked: config.expression === item.id,
              click: () => setExpression(item.id),
            }),
          ),
        })),
      ]);
      menu.popup({ window: pet });
      return;
    }
    case "connect": {
      const provider = typeof payload === "string" ? "dsh" : payload?.provider;
      const endpoint =
        typeof payload === "string" ? payload : payload?.endpoint;
      if (typeof endpoint !== "string") throw new Error("无效地址");
      if (
        managed &&
        provider === "dsh" &&
        normalizeEndpoint(endpoint) !== managed.endpoint
      )
        throw new Error("此桌宠由 DSH 插件管理，服务地址自动配置");
      return connect(endpoint, provider);
    }
    case "disconnect": {
      if (!PROVIDERS.includes(payload)) throw new Error("未知平台");
      if (managed && payload === "dsh") throw new Error("所属 DSH 由插件管理");
      client.disconnect(payload);
      config.enabledProviders = (config.enabledProviders || []).filter(
        (provider) => provider !== payload,
      );
      save();
      return;
    }
    case "refresh": {
      const next = client;
      await refreshSessions(next);
      await history(false, next);
      return;
    }
    case "balance":
      requireClient("", "dsh");
      return refreshBalance();
    case "select":
    case "openSession": {
      requireClient(payload);
      if (!state.sessions.some((item) => item.sessionId === payload))
        throw new Error("会话不存在，请刷新会话列表");
      if (state.selectedId !== payload) {
        state.selectedId = payload;
        config.selectedId = payload;
        config.provider = sessionSource(payload).provider;
        setEvents([]);
        state.hasMore = false;
        historyRevision++;
      }
      if (action === "openSession") showSection("chat");
      save();
      broadcast();
      await history();
      return payload;
    }
    case "older":
      if (payload?.sessionId && payload.sessionId !== state.selectedId) return;
      if (
        payload?.requestId !== undefined &&
        typeof payload.requestId !== "string"
      )
        throw new Error("无效的历史请求");
      requireClient();
      if (state.events.length >= MAX_HISTORY_EVENTS) {
        state.hasMore = false;
        broadcast();
        return;
      }
      return history(true, client, payload?.requestId);
    case "pickDirectory": {
      const result = await dialog.showOpenDialog(pet, {
        title: "选择会话使用的项目",
        properties: ["openDirectory"],
      });
      if (!result.canceled) {
        config.cwd = result.filePaths[0];
        save();
        broadcast();
      }
      return config.cwd;
    }
    case "defaultProvider": {
      if (!PROVIDERS.includes(payload)) throw new Error("未知平台");
      if (state.selectedId) throw new Error("当前会话的平台不能更改");
      config.provider = payload;
      save();
      updateConnections();
      return;
    }
    case "create": {
      const provider = payload?.provider || config.provider;
      if (!PROVIDERS.includes(provider)) throw new Error("请选择会话平台");
      if (
        payload?.requestId !== undefined &&
        typeof payload.requestId !== "string"
      )
        throw new Error("无效的创建请求");
      const next = requireClient("", provider),
        cwd = config.cwd;
      if (!cwd || !isAbsolute(cwd)) throw new Error("请先选择项目目录");
      const result = await next.rpc("session.create", {
        provider,
        cwd,
        sessionId: crypto.randomUUID(),
      });
      if (client !== next) return;
      config.provider = provider;
      state.selectedId = result.sessionId;
      config.selectedId = result.sessionId;
      if (!state.sessions.some((row) => row.sessionId === result.sessionId))
        state.sessions.push({
          sessionId: result.sessionId,
          provider,
          cwd,
          running: false,
          runningKnown: false,
          blank: true,
          updatedAt: Date.now(),
        });
      state.sessionCreation = payload?.requestId
        ? { requestId: payload.requestId, sessionId: result.sessionId }
        : null;
      setEvents([]);
      state.hasMore = false;
      historyRevision++;
      historyReloads.invalidate(result.sessionId);
      save();
      broadcast();
      // The write already succeeded. Auxiliary reads must not erase its
      // receipt; history failures remain visible and use the normal retry path.
      await refreshSessions(next, false, provider).catch(() =>
        scheduleHostRefresh(provider),
      );
      if (state.selectedId === result.sessionId)
        await history(false, next).catch(() => {});
      broadcast();
      return result.sessionId;
    }
    case "models": {
      const id = payload?.sessionId;
      if (
        typeof id !== "string" ||
        !state.sessions.some((session) => session.sessionId === id)
      )
        throw new Error("请先选择会话");
      return requireClient(id).rpc("session.models", { sessionId: id });
    }
    case "selectModel": {
      const id = payload?.sessionId;
      if (
        typeof id !== "string" ||
        !state.sessions.some((session) => session.sessionId === id)
      )
        throw new Error("请先选择会话");
      if (typeof payload.provider !== "string" || !payload.provider.trim())
        throw new Error("请选择模型供应商");
      if (
        typeof payload.model !== "string" ||
        !payload.model.trim() ||
        payload.model.length > 200
      )
        throw new Error("请选择有效模型");
      const effort =
        typeof payload.reasoningEffort === "string"
          ? payload.reasoningEffort.trim()
          : "";
      if (effort.length > 100) throw new Error("无效的推理强度");
      const next = requireClient(id);
      return next.rpc("session.selectModel", {
        sessionId: id,
        provider: payload.provider,
        model: payload.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
    }
    case "send": {
      const id =
        typeof payload === "string" ? state.selectedId : payload?.sessionId;
      const text = typeof payload === "string" ? payload : payload?.text;
      if (!id || !state.sessions.some((session) => session.sessionId === id))
        throw new Error("请先新建或选择对话");
      const next = requireClient(id);
      if (typeof text !== "string" || !text.trim() || text.length > 100000)
        throw new Error("请输入有效消息（最多 100000 字）");
      const result = await next.rpc("session.prompt", {
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // Never retry writes: an acknowledgement can be lost after acceptance.
      return result.command?.text || "";
    }
    case "cancel": {
      const id = payload?.sessionId || state.selectedId;
      if (!id || !state.sessions.some((session) => session.sessionId === id))
        throw new Error("请先选择会话");
      return requireClient(id).rpc("session.cancel", { sessionId: id });
    }
    case "answer": {
      const next = requireClient(),
        epoch = state.connectionEpoch,
        pending = state.pending.find(
          (item) =>
            item.rpcId === payload?.rpcId &&
            item.sessionId === state.selectedId,
        );
      if (!pending) throw new Error("待回答事项已失效");
      const value =
        pending.type === "approval/requested"
          ? {
              sessionId: pending.sessionId,
              approvalId: pending.approvalId,
              outcome: payload.outcome,
            }
          : {
              sessionId: pending.sessionId,
              answer: { answers: payload.answers },
            };
      if (
        pending.type === "approval/requested" &&
        !(pending.choices
          ? pending.choices.some((choice) => choice.value === payload.outcome)
          : ["allowed-once", "rejected"].includes(payload.outcome))
      )
        throw new Error("无效决定");
      await next.respond(pending.rpcId, value);
      if (client !== next || epoch !== state.connectionEpoch) return;
      state.pending = state.pending.filter(
        (item) => item.rpcId !== pending.rpcId,
      );
      broadcast();
      return;
    }
    case "drag:start": {
      finishPetDrag();
      const point = validDragPoint(payload);
      petDrag = { point, anchor: petAnchor(), moved: false };
      setPassthrough(false);
      return;
    }
    case "drag:move": {
      const point = validDragPoint(payload);
      if (!petDrag) return;
      const dx = point.x - petDrag.point.x,
        dy = point.y - petDrag.point.y;
      if (!petDrag.moved && Math.hypot(dx, dy) < 5) return;
      petDrag.moved = true;
      const anchor = { x: petDrag.anchor.x + dx, y: petDrag.anchor.y + dy };
      const area = screen.getDisplayNearestPoint({
        x: Math.round(point.x),
        y: Math.round(point.y),
      }).workArea;
      applyLayout(
        desktopLayout(
          anchor,
          area,
          state.surface.section,
          config.petScale,
          config.chatSize,
        ),
      );
      return;
    }
    case "drag:end": {
      const anchor = petAnchor();
      const moved =
        !!petDrag?.moved &&
        (anchor.x !== petDrag.anchor.x || anchor.y !== petDrag.anchor.y);
      finishPetDrag();
      return { moved };
    }
    case "petScale": {
      if (
        typeof payload !== "number" ||
        !Number.isFinite(payload) ||
        payload < PET_SCALE.min ||
        payload > PET_SCALE.max ||
        payload % PET_SCALE.step !== 0
      )
        throw new Error("桌宠大小需为 50%–150%，每档 5%");
      if (payload === config.petScale) return payload;
      const anchor = resizedPetAnchor(petAnchor(), config.petScale, payload);
      config.petScale = payload;
      showSection(state.surface.section, anchor);
      return payload;
    }
    case "chatSize":
      if (normalizeChatSize(payload) !== payload)
        throw new Error("对话框大小请选择小、中或大");
      if (payload === config.chatSize) return payload;
      config.chatSize = payload;
      showSection(state.surface.section);
      return payload;
    case "alwaysOnTop":
      config.alwaysOnTop = !!payload;
      windows().forEach((window) => window.setAlwaysOnTop(config.alwaysOnTop));
      save();
      broadcast();
      return;
    case "section":
      if (
        payload !== null &&
        !["chat", "expressions", "settings"].includes(payload)
      )
        throw new Error("未知入口");
      showSection(payload);
      return;
    case "passthrough": {
      if (event.sender !== pet.webContents) return;
      setPassthrough(!petDrag && !!payload && !cursorOverPanel());
      return;
    }
    case "openDsh":
      await shell.openExternal(
        managed?.managerEndpoint || normalizeEndpoint(config.endpoint),
      );
      return;
    default:
      throw new Error("不支持的操作");
  }
});
app.on("second-instance", () => {
  pet?.showInactive();
  if (pet) showSection("chat");
});
app.on("activate", () => {
  pet?.showInactive();
  if (pet) showSection("chat");
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  finishPetDrag();
  quitting = true;
  client?.close();
  clearInterval(pointerTimer);
  clearInterval(pollTimer);
  clearInterval(balanceTimer);
  clearTimeout(saveTimer);
  globalShortcut.unregisterAll();
  saveQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath() + ".tmp", JSON.stringify(config, null, 2));
      await rename(configPath() + ".tmp", configPath());
    })
    .catch(() => {})
    .finally(() => app.quit());
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
// Electron waits for the ESM entry to settle before ready: do not await ready at module scope.
app
  .whenReady()
  .then(async () => {
    if (!dataDirectory) {
      try {
        await readFile(configPath());
      } catch {
        try {
          const previous = await readFile(
            join(app.getPath("appData"), "dsh-girl", "settings.json"),
            "utf8",
          );
          await mkdir(dirname(configPath()), { recursive: true });
          await writeFile(configPath(), previous, { flag: "wx" });
        } catch {}
      }
    }
    try {
      const stored = JSON.parse(await readFile(configPath(), "utf8"));
      config = {
        ...config,
        ...stored,
        endpoint: normalizeEndpoint(stored.endpoint || config.endpoint),
        provider: stored.provider === "codex" ? "codex" : "dsh",
        codexEndpoint: normalizeCodexEndpoint(
          stored.codexEndpoint || config.codexEndpoint,
        ),
      };
      if (
        !stored.enabledProviders &&
        config.provider === "codex" &&
        config.selectedId
      )
        config.selectedId = sessionKey("codex", config.selectedId);
      state.config = config;
    } catch {}
    if (config.expression !== "auto" && !isExpressionId(config.expression))
      config.expression = "auto";
    if (typeof config.idleExpressions !== "boolean")
      config.idleExpressions = true;
    if (typeof config.animations !== "boolean") config.animations = true;
    if (typeof config.progressBubbles !== "boolean")
      config.progressBubbles = true;
    config.petScale = normalizePetScale(config.petScale);
    config.chatSize = normalizeChatSize(config.chatSize);
    config.sounds = normalizeSoundSettings(config.sounds);
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([
            { role: "appMenu" },
            { role: "editMenu" },
            { role: "windowMenu" },
          ])
        : null,
    );
    createWindows();
    if (managed) {
      config.provider = "dsh";
      config.endpoint = managed.endpoint;
      controller = managedControl(app, {
        show: () => pet.showInactive(),
        hide: () => pet.hide(),
        chat: () => showSection("chat"),
        stop: () => app.quit(),
      });
      controller.send({ type: "ready", version: app.getVersion() });
    }
    config.enabledProviders = Array.isArray(config.enabledProviders)
      ? [
          ...new Set(
            config.enabledProviders.filter((provider) =>
              PROVIDERS.includes(provider),
            ),
          ),
        ]
      : [config.provider];
    if (managed && !config.enabledProviders.includes("dsh"))
      config.enabledProviders.push("dsh");
    let externalHistoryPoll;
    pollTimer = setInterval(() => {
      for (const provider of PROVIDERS)
        void refreshSessions(client, true, provider).catch(() => {});
      if (
        !externalHistoryPoll &&
        state.surface.section === "chat" &&
        (historyReloads.snapshot(state.selectedId)
          ? historyReloads.needsRetry(state.selectedId)
          : state.sessions.some(
              (row) => row.sessionId === state.selectedId && row.readOnly,
            ))
      ) {
        externalHistoryPoll = history()
          .catch(() => {})
          .finally(() => {
            externalHistoryPoll = null;
          });
      }
    }, 3000);
    balanceTimer = setInterval(() => refreshBalance(), 60000);
    // Managed startup can precede the host's API activation. Only retry reads/connects.
    const startConnection = async (provider) => {
      for (
        let attempt = 0;
        attempt < (managed && provider === "dsh" ? 20 : 1);
        attempt++
      ) {
        if (quitting) return;
        try {
          await connect(
            provider === "codex" ? config.codexEndpoint : config.endpoint,
            provider,
            false,
          );
          return;
        } catch {
          if (quitting) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };
    for (const provider of [...config.enabledProviders])
      void startConnection(provider);
  })
  .catch((error) => {
    console.error("dsh-desk-buddy 启动失败：", error.message);
    app.quit();
  });
