import { EventEmitter } from "node:events";
import { DshClient } from "./dsh-client.mjs";
import { CodexClient } from "./codex-client.mjs";
import { latestTurn, turnState } from "./turn-state.mjs";

export const PROVIDERS = ["dsh", "codex"];
// Preserve ordinary DSH IDs for saved selections. Escape reserved prefixes so
// even equal IDs (or DSH IDs beginning with "codex:") cannot cross platforms.
export function sessionKey(provider, id) {
  if (!PROVIDERS.includes(provider) || typeof id !== "string")
    throw new Error("无效会话来源");
  return provider === "codex"
    ? `codex:${id}`
    : /^(codex:|~)/.test(id)
      ? `~${id}`
      : id;
}
export function sessionSource(key) {
  if (typeof key !== "string") throw new Error("无效会话");
  if (key.startsWith("~")) return { provider: "dsh", id: key.slice(1) };
  if (key.startsWith("codex:")) return { provider: "codex", id: key.slice(6) };
  return { provider: "dsh", id: key };
}

// Shared across overlapping refreshes of one connection, so superseded reads
// cannot multiply the number of history RPCs. Queued stale work exits on entry.
function limiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    }
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

export class SessionClients extends EventEmitter {
  entries = new Map();
  serial = 0;
  attempts = new Map();
  pending = new Map();
  constructor({
    connectTimeout = 30000,
    historyConcurrency = 4,
    factory = (provider, endpoint, options) =>
      provider === "codex"
        ? new CodexClient(endpoint)
        : new DshClient(endpoint, options),
  } = {}) {
    super();
    this.factory = factory;
    this.connectTimeout = connectTimeout;
    if (!Number.isInteger(historyConcurrency) || historyConcurrency < 1)
      throw new Error("历史并发数必须为正整数");
    this.historyConcurrency = historyConcurrency;
  }
  connections() {
    return Object.fromEntries(
      PROVIDERS.map((provider) => {
        const row = this.entries.get(provider);
        return [
          provider,
          {
            status: row?.status || "offline",
            message: row?.message || "",
            host: row?.host || null,
            epoch: row?.epoch || 0,
          },
        ];
      }),
    );
  }
  current(row) {
    return this.entries.get(row.provider) === row;
  }
  require(provider) {
    const row = this.entries.get(provider);
    if (row?.status !== "connected")
      throw new Error(`请先连接 ${provider === "codex" ? "Codex" : "DSH"}`);
    return row;
  }
  check(row, epoch) {
    if (!this.current(row) || row.epoch !== epoch || row.status !== "connected")
      throw new Error("平台连接已变化，请检查会话状态后重试");
  }
  invalidate(row, removeSessions) {
    row.epoch = ++this.serial;
    row.refreshRevision++;
    row.eventSeq.clear();
    row.runtime.clear();
    row.turns.clear();
    row.turnRevisions.clear();
    if (removeSessions) {
      row.observedTurns.clear();
      row.turnAnchors.clear();
    }
    for (const [key, request] of this.pending)
      if (request.provider === row.provider) this.pending.delete(key);
    row.sessions = removeSessions
      ? []
      : row.sessions.map((session) => ({
          ...session,
          running: false,
          runningKnown: false,
          lastTurn: undefined,
          projections: undefined,
        }));
    this.emit("reset", { provider: row.provider, removeSessions });
  }
  async connect(provider, endpoint, options) {
    if (!PROVIDERS.includes(provider)) throw new Error("未知平台");
    // A candidate owns no public state until both event streams are ready.
    const adapter = this.factory(provider, endpoint, options);
    this.attempts.get(provider)?.cancel();
    const previous = this.entries.get(provider);
    const row = {
      provider,
      client: adapter,
      status: "connecting",
      message: "",
      host: null,
      sessions: [],
      epoch: ++this.serial,
      refreshRevision: 0,
      lastRefresh: 0,
      refreshes: 0,
      seed: limiter(this.historyConcurrency),
      eventSeq: new Map(),
      runtime: new Map(),
      runtimeRevision: 0,
      turns: new Map(),
      // The latest verified history head survives automatic reconnect. It is
      // an ordering anchor, not a claim that the task is still running.
      turnAnchors: new Map(),
      turnRevisions: new Map(),
      observedTurns: new Set(),
    };
    let committed = false,
      rejectReady;
    const buffered = [];
    const ready = new Promise((resolve) => {
      row.ready = resolve;
    });
    // Failure must remain rejectable even after streams opened, while the
    // host handshake is still pending. This also bounds cancellation latency.
    const failed = new Promise((_, reject) => {
      rejectReady = reject;
    });
    const attempt = {
      cancel: () => {
        rejectReady(new Error("平台连接已更换"));
        adapter.close();
        if (!committed && !previous && this.current(row))
          this.entries.delete(provider);
      },
    };
    this.attempts.set(provider, attempt);
    if (!previous) this.entries.set(provider, row);
    else
      previous.message =
        previous.status === "connected"
          ? "正在验证新连接，当前连接仍可使用"
          : "正在验证新连接";
    this.emit("status");
    const dispatch = (kind, event) => {
      if (!committed) {
        if (buffered.length >= 1000)
          rejectReady(new Error("新连接事件过多，请重试"));
        else buffered.push([kind, event]);
        return;
      }
      if (!this.current(row)) return;
      if (kind === "frame") this.frame(row, event);
      else this.emit("stream-start", { ...event, provider });
    };
    adapter.on("frame", (event) => dispatch("frame", event));
    adapter.on("stream-start", (event) => dispatch("stream-start", event));
    adapter.on("retry", ({ delay }) => {
      if (committed && this.current(row)) {
        row.message = `Codex 连接中断，${Math.ceil(delay / 1000)} 秒后重试`;
        this.emit("status");
      }
    });
    adapter.on("stream", ({ kind, connected, message }) => {
      if (!committed) {
        if (!connected) rejectReady(new Error(message || "新连接事件流未就绪"));
        else if (adapter.streams.size === 2) row.ready();
        return;
      }
      if (!this.current(row)) return;
      if (!connected) {
        row.status = "reconnecting";
        row.message = message || "正在重新连接";
        if (kind === "mux") this.invalidate(row, false);
      } else if (adapter.streams.size === 2) {
        row.status = "connected";
        row.message = "";
        row.lastRefresh = 0;
        this.emit("ready", { provider });
      }
      this.emit("status");
    });
    const timer = setTimeout(
      () => rejectReady(new Error("平台连接就绪超时")),
      this.connectTimeout,
    );
    try {
      const [host] = await Promise.race([
        Promise.all([adapter.connect(), ready]),
        failed,
      ]);
      if (this.attempts.get(provider) !== attempt) return;
      if (adapter.streams.size !== 2) throw new Error("新连接事件流已断开");
      this.entries.set(provider, row);
      previous?.client.close();
      this.invalidate(row, true);
      row.host = host;
      row.status = "connected";
      committed = true;
      for (const [kind, event] of buffered) dispatch(kind, event);
      buffered.length = 0;
      this.emit("ready", { provider });
      this.emit("status");
      return host;
    } catch (error) {
      adapter.close();
      if (this.attempts.get(provider) !== attempt) return;
      if (previous) previous.message = `切换失败：${error.message}`;
      else {
        row.status = "offline";
        row.message = error.message;
        this.invalidate(row, true);
      }
      this.emit("status");
      throw error;
    } finally {
      clearTimeout(timer);
      delete row.ready;
      if (this.attempts.get(provider) === attempt)
        this.attempts.delete(provider);
    }
  }
  disconnect(provider) {
    this.attempts.get(provider)?.cancel();
    this.attempts.delete(provider);
    const row = this.entries.get(provider);
    if (!row) {
      this.emit("status");
      return;
    }
    row.client.close();
    row.status = "offline";
    row.message = "";
    row.host = null;
    this.invalidate(row, true);
    this.emit("status");
  }
  setRunning(row, id, running, turn) {
    row.runtime.set(id, { running, revision: ++row.runtimeRevision });
    const session = row.sessions.find((s) => s.sessionId === id);
    if (session) {
      session.running = running;
      session.runningKnown = true;
      if (turn && !session.readOnly) session.lastTurn = turn;
    }
  }
  frame(row, frame) {
    const original = frame.payload,
      payload = { ...original, provider: row.provider };
    const scoped = (value) => JSON.stringify([row.provider, row.epoch, value]);
    if (typeof payload.sessionId === "string")
      payload.sessionId = sessionKey(row.provider, payload.sessionId);
    if (payload.projections && payload.type === "session/projections")
      payload.projections = Object.fromEntries(
        Object.entries(payload.projections).map(([id, block]) => [
          sessionKey(row.provider, id),
          block,
        ]),
      );
    if (payload.approvalId !== undefined)
      payload.approvalId = scoped(payload.approvalId);
    if (payload.questionRpcId !== undefined)
      payload.questionRpcId = scoped(payload.questionRpcId);
    const rpcId = scoped(frame.rpcId);
    if (["approval/requested", "question/requested"].includes(payload.type))
      this.pending.set(rpcId, {
        provider: row.provider,
        epoch: row.epoch,
        rpcId: frame.rpcId,
        approvalId: original.approvalId,
        sessionId: original.sessionId,
      });
    if (
      payload.type === "approval/resolved" ||
      payload.type === "question/resolved"
    ) {
      for (const [key, request] of this.pending)
        if (
          request.provider === row.provider &&
          (payload.type === "approval/resolved"
            ? request.approvalId === original.approvalId
            : request.rpcId === original.questionRpcId)
        )
          this.pending.delete(key);
    }
    // These rows are shared with the main process. Check sequence numbers
    // BEFORE mutating them, including when a newer non-boundary event arrived.
    // Still forward old events so history can merge them independently.
    const id = payload.sessionId;
    if (payload.type === "host/session-status") {
      if (row.provider === "dsh") {
        // DSH's host and mux sockets have no shared ordering. A delayed host
        // status is only an invalidation; query current state instead of
        // overwriting a newer turn (and reopening its dismissed bubble).
        payload.type = "host/session-invalidated";
        delete payload.running;
      } else this.setRunning(row, id, payload.running);
    }
    if (payload.type === "session/event") {
      const event = payload.event;
      if (
        Number.isSafeInteger(event?.seq) &&
        event.seq > (row.eventSeq.get(id) ?? -1)
      ) {
        row.eventSeq.set(id, event.seq);
        if (["turn/start", "turn/end"].includes(event.type)) {
          const turn = turnState(
            event,
            row.turns.get(id) ?? row.turnAnchors.get(id),
          );
          row.observedTurns.add(id);
          if (turn) {
            row.turns.set(id, turn);
            row.turnAnchors.set(id, turn);
            payload.lastTurn = turn;
          }
          this.setRunning(row, id, event.type === "turn/start", turn);
        }
      }
    }
    if (payload.type === "host/session-removed") {
      row.sessions = row.sessions.filter((session) => session.sessionId !== id);
      row.eventSeq.delete(id);
      row.turns.delete(id);
      row.turnAnchors.delete(id);
      row.turnRevisions.delete(id);
      row.observedTurns.delete(id);
      row.runtime.set(id, { removed: true, revision: ++row.runtimeRevision });
    }
    this.emit("frame", { ...frame, rpcId, payload, epoch: row.epoch });
  }
  async list({ poll = false, provider } = {}) {
    await Promise.all(
      [...this.entries.values()].map(async (row) => {
        if (
          (provider && row.provider !== provider) ||
          row.status !== "connected" ||
          (poll &&
            (row.refreshes > 0 ||
              Date.now() - row.lastRefresh <
                (row.client.pollInterval || 20000)))
        )
          return;
        const epoch = row.epoch,
          revision = ++row.refreshRevision,
          runtimeRevision = row.runtimeRevision;
        row.refreshes++;
        row.lastRefresh = Date.now();
        try {
          // poll is a Codex cache hint, not a DSH protocol field.
          const result = await row.client.rpc(
            "session.list",
            row.provider === "codex" ? { poll } : {},
          );
          if (
            !this.current(row) ||
            row.epoch !== epoch ||
            row.refreshRevision !== revision
          )
            return;
          if (!Array.isArray(result?.items))
            throw new Error("无法识别平台会话列表");
          // A running boolean cannot distinguish the same task from a new one
          // started while disconnected or unsubscribed. Seed identity for each
          // subscription, including read-only history of previously observed
          // work. Never replay history as activity or sound.
          await Promise.all(
            result.items.map((item) =>
              row.seed(async () => {
                if (
                  !this.current(row) ||
                  row.epoch !== epoch ||
                  row.refreshRevision !== revision
                )
                  return;
                const id = sessionKey(row.provider, item.sessionId);
                if (item.origin === "subagent" || row.runtime.get(id)?.removed)
                  return;
                if (item.running && !item.readOnly) row.observedTurns.add(id);
                const previous = row.turns.get(id);
                if (
                  !row.observedTurns.has(id) ||
                  (previous &&
                    row.turnRevisions.get(id) === item.followRevision)
                )
                  return;
                let turn,
                  historyRead = false;
                const anchor = row.turnAnchors.get(id);
                try {
                  const history = await row.client.rpc("session.history", {
                    sessionId: item.sessionId,
                    ...(row.provider === "codex"
                      ? { previousTurn: anchor }
                      : {}),
                  });
                  historyRead = Array.isArray(history?.events);
                  turn = latestTurn(history?.events);
                  if (turn && anchor?.key === turn.key)
                    turn = { ...anchor, ...turn };
                  if (turn && history?.historical) turn.historical = true;
                } catch {
                  // An unavailable history is unknown, not a new turn. Retry on
                  // the next list without disturbing the previous dismissal.
                }
                if (
                  !this.current(row) ||
                  row.epoch !== epoch ||
                  row.refreshRevision !== revision ||
                  row.runtime.get(id)?.removed
                )
                  return;
                // A boundary received during the read is fresher than history,
                // including when that read fails. Keep its turn and dismissal.
                if (row.turns.get(id) !== previous) {
                  row.turnRevisions.set(id, item.followRevision);
                } else if (turn) {
                  row.turns.set(id, turn);
                  row.turnAnchors.set(id, turn);
                  row.turnRevisions.set(id, item.followRevision);
                } else if (historyRead) {
                  // A verified empty history is a new baseline. Work added
                  // after a full rollback can be new even without timestamps.
                  row.turnAnchors.set(id, null);
                }
              }),
            ),
          );
          if (
            !this.current(row) ||
            row.epoch !== epoch ||
            row.refreshRevision !== revision
          )
            return;
          row.sessions = result.items
            .filter((item) => {
              const runtime = row.runtime.get(
                sessionKey(row.provider, item.sessionId),
              );
              return !(runtime?.removed && runtime.revision > runtimeRevision);
            })
            .map((item) => {
              const sessionId = sessionKey(row.provider, item.sessionId),
                runtime = row.runtime.get(sessionId);
              return {
                ...item,
                sessionId,
                provider: row.provider,
                metadataRevision: revision,
                lastTurn:
                  row.turnRevisions.get(sessionId) === item.followRevision
                    ? row.turns.get(sessionId)
                    : undefined,
                // A turn may start/end while its first list is in flight.
                // Never overwrite that newer live state with the older snapshot.
                running:
                  !item.readOnly &&
                  !runtime?.removed &&
                  runtime?.revision > runtimeRevision
                    ? runtime.running
                    : item.running,
                runningKnown: true,
              };
            });
        } catch (error) {
          if (this.current(row) && row.epoch === epoch) {
            row.message = error.message;
            this.emit("status");
          }
        } finally {
          row.refreshes--;
        }
      }),
    );
    return { items: [...this.entries.values()].flatMap((row) => row.sessions) };
  }
  async rpc(method, payload = {}) {
    if (method === "session.list") return this.list(payload);
    const creating = method === "session.create";
    const { provider, id } = creating
      ? { provider: payload.provider, id: payload.sessionId }
      : sessionSource(payload.sessionId);
    const row = this.require(provider),
      epoch = row.epoch;
    const { provider: _provider, ...input } = payload;
    const result = await row.client.rpc(method, { ...input, sessionId: id });
    this.check(row, epoch);
    return creating
      ? {
          ...result,
          sessionId: sessionKey(provider, result.sessionId),
          provider,
        }
      : result;
  }
  async respond(rpcId, value) {
    const request = this.pending.get(rpcId);
    if (
      !request ||
      sessionKey(request.provider, request.sessionId) !== value.sessionId
    )
      throw new Error("待回答事项已失效");
    const row = this.require(request.provider);
    this.check(row, request.epoch);
    const result = await row.client.respond(request.rpcId, {
      ...value,
      sessionId: request.sessionId,
      ...(request.approvalId !== undefined
        ? { approvalId: request.approvalId }
        : {}),
    });
    this.check(row, request.epoch);
    this.pending.delete(rpcId);
    return result;
  }
  async balance() {
    const row = this.require("dsh"),
      epoch = row.epoch;
    const result = await row.client.balance();
    this.check(row, epoch);
    return result;
  }
  close() {
    for (const attempt of this.attempts.values()) attempt.cancel();
    this.attempts.clear();
    for (const row of this.entries.values()) row.client.close();
    this.entries.clear();
    this.pending.clear();
    this.removeAllListeners();
  }
}
