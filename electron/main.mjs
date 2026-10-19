import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  dialog,
  shell,
} from "electron";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { DshClient, normalizeEndpoint } from "../shared/dsh-client.mjs";
import { mergeEvents } from "../shared/projection.mjs";
import { EXPRESSIONS, isExpressionId } from "../shared/expressions.mjs";
import { reduceActivity, reconcileActivity } from "../shared/activity.mjs";
import { recordCompletion } from "../shared/completion.mjs";
import { reduceAssistantStream } from "../shared/assistant-stream.mjs";
import { managedLaunch, managedControl } from "./managed.mjs";
import {
  desktopLayout,
  PET_SCALE,
  normalizePetScale,
  petSize,
  resizedPetAnchor,
} from "../shared/desktop-layout.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const managed = managedLaunch();
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
  client,
  quitting = false,
  saveTimer,
  pollTimer,
  balanceTimer,
  broadcastTimer;
let connectRevision = 0,
  historyRevision = 0,
  refreshRevision = 0;
let config = {
  endpoint: "http://127.0.0.1:3080",
  cwd: "",
  selectedId: "",
  alwaysOnTop: true,
  petPosition: null,
  expression: "auto",
  idleExpressions: true,
  animations: true,
  petScale: PET_SCALE.default,
};
let state = {
  managed: !!managed,
  connection: "offline",
  connectionMessage: "",
  host: null,
  sessions: [],
  selectedId: "",
  events: [],
  liveAssistant: {},
  hasMore: false,
  pending: [],
  activity: {},
  completions: [],
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
const windows = () => [pet].filter((window) => window && !window.isDestroyed());
function broadcast() {
  controller?.send({
    type: "status",
    connection: state.connection,
    visible:
      !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(),
  });
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(
    () =>
      windows().forEach((window) =>
        window.webContents.send("desktop:state", state),
      ),
    35,
  );
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
function clampBounds(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  return {
    ...bounds,
    x: Math.round(
      Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(bounds.y, area.y + area.height - bounds.height),
      ),
    ),
  };
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
function applyLayout(layout, fullState = false) {
  const changed =
    JSON.stringify(state.surface) !== JSON.stringify(layout.surface);
  state.surface = layout.surface;
  arranging = true;
  if (fullState) pet.webContents.send("desktop:state", state);
  else if (changed) pet.webContents.send("desktop:surface", state.surface);
  pet.setBounds(layout.bounds);
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
function showSection(section, anchor) {
  if (!pet || pet.isDestroyed()) return;
  anchor ||= petAnchor();
  const area = screen.getDisplayMatching({
    ...anchor,
    ...petSize(config.petScale),
  }).workArea;
  const layout = desktopLayout(anchor, area, section, config.petScale);
  applyLayout(layout, true);
  config.petPosition = petAnchor();
  save();
  pet.setIgnoreMouseEvents(false);
  if (section) {
    pet.show();
    pet.focus();
  } else pet.showInactive();
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
  pet = createWindow(
    {
      ...clampBounds({ ...position, ...size }),
      frame: false,
      transparent: true,
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
  screen.on("display-removed", () => showSection(state.surface.section));
  screen.on("display-metrics-changed", () =>
    showSection(state.surface.section),
  );
  const pixels = Buffer.alloc(18 * 18 * 4);
  for (let y = 0; y < 18; y++)
    for (let x = 0; x < 18; x++) {
      if (
        (x - 10) ** 2 / 45 + (y - 10) ** 2 / 23 < 1 ||
        (x < 6 && y > 4 && y < 13 && Math.abs(y - 8) > x - 1)
      )
        pixels.set([67, 100, 214, 255], (y * 18 + x) * 4);
    }
  const icon = nativeImage.createFromBitmap(pixels, { width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
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
async function refreshSessions(expectedClient = client) {
  if (!expectedClient) return;
  const revision = ++refreshRevision;
  const result = await expectedClient.rpc("session.list");
  if (client !== expectedClient || revision !== refreshRevision) return;
  if (!Array.isArray(result?.items)) throw new Error("无法识别 DSH 会话列表");
  // Ordinary forks remain writable; only agent-owned subagents use another API.
  state.sessions = result.items
    .filter((item) => item.origin !== "subagent")
    .map((item) => {
      const newer = state.sessions.find(
        (row) => row.sessionId === item.sessionId,
      );
      if (
        (newer?.projections?.asOfSeq ?? -1) > (item.projections?.asOfSeq ?? -1)
      )
        item.projections = newer.projections;
      return item;
    });
  for (const row of state.sessions) {
    state.activity[row.sessionId] = reconcileActivity(
      state.activity[row.sessionId],
      row.running,
    );
  }
  if (
    !state.selectedId &&
    state.sessions.some((item) => item.sessionId === config.selectedId)
  )
    state.selectedId = config.selectedId;
  if (
    state.selectedId &&
    !state.sessions.some((item) => item.sessionId === state.selectedId)
  ) {
    state.selectedId = "";
    state.events = [];
    state.hasMore = false;
  }
  broadcast();
}
async function history(older = false, expectedClient = client) {
  const id = state.selectedId;
  if (!id || !expectedClient) return;
  const revision = historyRevision;
  const beforeSeq = older ? state.events[0]?.seq : undefined;
  const result = await expectedClient.rpc("session.history", {
    sessionId: id,
    maxMessages: 40,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  });
  if (
    client !== expectedClient ||
    id !== state.selectedId ||
    revision !== historyRevision
  )
    return;
  if (!Array.isArray(result?.events)) throw new Error("无法识别 DSH 会话历史");
  const incoming = result.events.map((entry) => entry.event);
  const previousHead = state.events[0]?.seq ?? Infinity;
  state.events = mergeEvents(state.events, incoming);
  if (older || (incoming[0]?.seq ?? Infinity) <= previousHead)
    state.hasMore = result.hasMore;
  if (result.projections) {
    const row = state.sessions.find((item) => item.sessionId === id);
    if (row && (row.projections?.asOfSeq ?? -1) <= result.projections.asOfSeq)
      row.projections = result.projections;
  }
  broadcast();
}
async function refreshBalance(expectedClient = client) {
  if (!expectedClient) return;
  try {
    const result = await expectedClient.balance();
    if (client !== expectedClient) return;
    if (!result.ok) throw new Error(result.error || "无法读取余额");
    if (
      !Array.isArray(result.balances) ||
      !result.balances.length ||
      result.balances.some(
        (row) =>
          !Number.isFinite(row.total) || !["CNY", "USD"].includes(row.currency),
      )
    )
      throw new Error("余额响应格式不兼容");
    state.balance = result;
    state.balanceError = result.stale ? result.error || "当前为旧数据" : "";
  } catch (error) {
    if (client !== expectedClient) return;
    state.balanceError = /404/.test(error.message)
      ? "尚未安装余额插件"
      : error.message;
  }
  broadcast();
}
function handleFrame(frame) {
  const payload = frame.payload,
    id = payload.sessionId;
  const row = state.sessions.find((item) => item.sessionId === id);
  if (payload.type === "session/assistant-stream") {
    const previousStream = state.liveAssistant[id];
    state.liveAssistant[id] = reduceAssistantStream(
      previousStream,
      payload.frame,
    );
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
    if (
      [
        "assistant/message",
        "assistant/attempt",
        "turn/end",
        "turn/start",
      ].includes(event.type)
    )
      delete state.liveAssistant[id];
    if (id === state.selectedId)
      state.events = mergeEvents(state.events, [event]);
    const previous = state.activity[id];
    const activity = reduceActivity(previous, event);
    state.activity[id] = activity;
    // Ignore duplicate/reordered events for reactions AND running flags.
    if (activity === previous) return broadcast();
    state.completions = recordCompletion(state.completions, id, event);
    if (event.type === "turn/start") {
      if (row) row.running = true;
    }
    if (event.type === "turn/end") {
      if (row) row.running = false;
      if (id === state.selectedId) history().catch(() => {});
    }
  }
  if (payload.type === "host/session-status") {
    if (row) row.running = payload.running;
    state.activity[id] = reconcileActivity(state.activity[id], payload.running);
  }
  if (payload.type === "host/agent-error")
    state.activity[id] = {
      ...state.activity[id],
      status: "error",
      tools: {},
      reaction: { mood: "shocked", at: Date.now(), until: Date.now() + 4000 },
      message: payload.message,
      at: Date.now(),
    };
  if (
    payload.type === "host/session-added" ||
    payload.type === "host/session-removed"
  )
    refreshSessions().catch(() => {});
  if (payload.type === "session/projection" && row) {
    const previous = row.projections || { asOfSeq: -1, values: {} };
    if (payload.seq >= previous.asOfSeq)
      row.projections = {
        asOfSeq: payload.seq,
        values: { ...previous.values, [payload.key]: payload.value },
      };
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
async function connect(endpoint) {
  endpoint = normalizeEndpoint(endpoint);
  const revision = ++connectRevision;
  client?.close();
  clearInterval(pollTimer);
  clearInterval(balanceTimer);
  const previousEndpoint = config.endpoint;
  config.endpoint = endpoint;
  save();
  if (endpoint !== previousEndpoint) {
    config.selectedId = "";
    state.selectedId = "";
    state.events = [];
    state.hasMore = false;
  }
  state.connection = "connecting";
  state.connectionMessage = "";
  state.pending = [];
  state.activity = {};
  state.liveAssistant = {};
  state.completions = [];
  state.sessions = [];
  state.host = null;
  state.balance = null;
  state.balanceError = "";
  broadcast();
  const next = new DshClient(endpoint, { token: managed?.token });
  client = next;
  next.on("frame", handleFrame);
  next.on("stream", ({ kind, connected, message }) => {
    if (client !== next) return;
    if (!connected) {
      if (kind === "mux") {
        state.pending = [];
        state.liveAssistant = {};
      }
      state.connection = "reconnecting";
      state.connectionMessage = message || "正在重新连接";
    }
    if (connected && next.streams.size === 2) {
      state.connection = "connected";
      state.connectionMessage = "";
      refreshSessions(next)
        .then(() => history(false, next))
        .catch((error) => {
          state.connectionMessage = error.message;
          broadcast();
        });
    }
    broadcast();
  });
  try {
    const host = await next.connect();
    if (revision !== connectRevision) return;
    state.host = host;
    if (!config.cwd) config.cwd = host.cwd;
    await refreshSessions(next);
    await history(false, next);
    refreshBalance(next);
    pollTimer = setInterval(() => refreshSessions(next).catch(() => {}), 20000);
    balanceTimer = setInterval(() => refreshBalance(next), 60000);
    broadcast();
  } catch (error) {
    if (revision !== connectRevision) return;
    next.close();
    state.connection = "offline";
    state.connectionMessage =
      error.cause?.code === "ECONNREFUSED" || /fetch failed/.test(error.message)
        ? managed
          ? "暂未连上所属 DSH，请在 DSH 的桌宠管理入口重新启动桌宠"
          : "未找到 DSH 服务，请先启动 DSH Web，再点击连接"
        : error.message;
    broadcast();
    throw new Error(state.connectionMessage);
  }
}
function requireClient() {
  if (!client || state.connection !== "connected")
    throw new Error("请先连接 DSH");
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
    case "visibility": {
      const window = BrowserWindow.fromWebContents(event.sender);
      return window.isVisible() && !window.isMinimized();
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
    case "connect":
      if (typeof payload !== "string") throw new Error("无效地址");
      if (managed && normalizeEndpoint(payload) !== managed.endpoint)
        throw new Error("此桌宠由 DSH 插件管理，服务地址自动配置");
      return connect(payload);
    case "refresh": {
      const next = requireClient();
      await refreshSessions(next);
      await history(false, next);
      return;
    }
    case "balance":
      return refreshBalance(requireClient());
    case "select": {
      requireClient();
      if (!state.sessions.some((item) => item.sessionId === payload))
        throw new Error("会话不存在，请刷新会话列表");
      state.selectedId = payload;
      config.selectedId = payload;
      state.events = [];
      state.hasMore = false;
      historyRevision++;
      save();
      broadcast();
      await history();
      return payload;
    }
    case "older":
      requireClient();
      return history(true);
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
    case "create": {
      const next = requireClient(),
        cwd = config.cwd;
      if (!cwd || !isAbsolute(cwd)) throw new Error("请先选择项目目录");
      const result = await next.rpc("session.create", {
        cwd,
        sessionId: crypto.randomUUID(),
      });
      if (client !== next) return;
      state.selectedId = result.sessionId;
      config.selectedId = result.sessionId;
      state.events = [];
      state.hasMore = false;
      historyRevision++;
      save();
      await refreshSessions(next);
      await history(false, next);
      broadcast();
      return result.sessionId;
    }
    case "send": {
      const next = requireClient();
      if (
        typeof payload !== "string" ||
        !payload.trim() ||
        payload.length > 100000
      )
        throw new Error("请输入有效消息（最多 100000 字）");
      if (!state.selectedId) throw new Error("请先新建或选择对话");
      const result = await next.rpc("session.prompt", {
        sessionId: state.selectedId,
        mode: "queue",
        content: [{ type: "text", text: payload }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // No automatic retries: a lost acknowledgement can still mean the prompt was accepted.
      if (result.command?.text) return result.command.text;
      return "";
    }
    case "cancel": {
      const next = requireClient();
      if (!state.selectedId) throw new Error("请先选择会话");
      return next.rpc("session.cancel", { sessionId: state.selectedId });
    }
    case "answer": {
      const next = requireClient(),
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
        !["allowed-once", "rejected"].includes(payload.outcome)
      )
        throw new Error("无效决定");
      await next.respond(pending.rpcId, value);
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
      pet.setIgnoreMouseEvents(false);
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
        desktopLayout(anchor, area, state.surface.section, config.petScale),
      );
      return;
    }
    case "drag:end":
      finishPetDrag();
      return;
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
    case "passthrough":
      if (event.sender === pet.webContents)
        pet.setIgnoreMouseEvents(petDrag ? false : !!payload, {
          forward: true,
        });
      return;
    case "openDsh":
      await shell.openExternal(normalizeEndpoint(config.endpoint));
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
      };
      state.config = config;
    } catch {}
    if (config.expression !== "auto" && !isExpressionId(config.expression))
      config.expression = "auto";
    if (typeof config.idleExpressions !== "boolean")
      config.idleExpressions = true;
    if (typeof config.animations !== "boolean") config.animations = true;
    config.petScale = normalizePetScale(config.petScale);
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
      config.endpoint = managed.endpoint;
      controller = managedControl(app, {
        show: () => pet.showInactive(),
        hide: () => pet.hide(),
        chat: () => showSection("chat"),
        stop: () => app.quit(),
      });
      controller.send({ type: "ready", version: app.getVersion() });
    }
    // Managed startup can precede the host's API activation. Only retry reads/connects.
    const startConnection = async () => {
      for (let attempt = 0; attempt < (managed ? 20 : 1); attempt++) {
        if (quitting) return;
        try {
          await connect(config.endpoint);
          return;
        } catch {
          if (quitting) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };
    void startConnection();
  })
  .catch((error) => {
    console.error("dsh-desk-buddy 启动失败：", error.message);
    app.quit();
  });
