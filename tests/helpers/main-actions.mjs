import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { HistoryReloads } from "../../electron/history-reloads.mjs";
import {
  MAX_HISTORY_EVENTS,
  setHistoryEvents,
} from "../../electron/history-state.mjs";
import { mergeEvents } from "../../shared/projection.mjs";
import { SessionProjections } from "../../shared/session-projections.mjs";
import { PROVIDERS, sessionSource } from "../../shared/session-clients.mjs";

// Exercise the real IPC handler and its reads without starting Electron or
// opening native windows. Only OS services and transport are substituted.
const source = await readFile(
  new URL("../../electron/main.mjs", import.meta.url),
  "utf8",
);
const actionStart = source.indexOf('ipcMain.handle("desktop:action",');
const actionEnd = source.indexOf("\n});", actionStart) + "\n});".length;
const readsStart = source.indexOf("async function refreshSessions(");
const readsEnd = source.indexOf("const refreshBalance =", readsStart);
const pollStart = source.indexOf("    let externalHistoryPoll;");
const pollEnd = source.indexOf("    balanceTimer = setInterval", pollStart);
const connectionsStart = source.indexOf("function updateConnections()");
const connectionsEnd = source.indexOf(
  "async function connect(",
  connectionsStart,
);
if (
  actionStart < 0 ||
  readsStart < 0 ||
  readsEnd < readsStart ||
  actionEnd <= actionStart ||
  pollStart < 0 ||
  pollEnd <= pollStart ||
  connectionsStart < 0 ||
  connectionsEnd <= connectionsStart
)
  throw new Error("Main-process test entry points not found");

export function mainActions({
  client,
  state,
  config = state.config,
  connectionLifecycle = false,
}) {
  const webContents = {};
  const stores = new Map();
  const published = [];
  const historyReloads = new HistoryReloads();
  let handler, poll;
  const context = {
    client,
    state,
    config,
    historyReloads,
    PROVIDERS,
    sessionSource,
    isAbsolute,
    mergeEvents,
    MAX_HISTORY_EVENTS,
    crypto: { randomUUID },
    historyRevision: 0,
    snapshotRevision: 0,
    ipcMain: {
      handle(_channel, callback) {
        handler = callback;
      },
    },
    setInterval(callback) {
      poll = callback;
      return 1;
    },
    windows: () => [{ webContents }],
    requireClient: () => client,
    setEvents: (events, hasMore) => setHistoryEvents(state, events, hasMore),
    projectionFor(id) {
      if (!stores.has(id)) stores.set(id, new SessionProjections());
      return stores.get(id);
    },
    progressTracker: { prune() {}, forget() {} },
    controlSnapshots: new Map(),
    projections: stores,
    refreshBalance: async () => {},
    handleFrame() {},
    reconcileSessionActivity: (activity) => activity,
    scheduleHostRefresh() {},
    save() {},
    broadcast() {
      state.historyReload = historyReloads.snapshot(state.selectedId);
      published.push(structuredClone(state));
    },
  };
  runInNewContext(
    source.slice(readsStart, readsEnd) +
      source.slice(actionStart, actionEnd) +
      source.slice(pollStart, pollEnd) +
      (connectionLifecycle
        ? source.slice(connectionsStart, connectionsEnd)
        : ""),
    context,
  );
  return {
    invoke: (action, payload) =>
      handler({ sender: webContents }, action, payload),
    published,
    historyReloads,
    refreshSessions: context.refreshSessions,
    poll: () => poll(),
  };
}
