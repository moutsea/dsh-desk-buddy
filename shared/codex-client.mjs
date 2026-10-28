import { EventEmitter } from "node:events";
import { clearTimeout as clearNodeTimeout } from "node:timers";
import { CodexTransport, normalizeCodexEndpoint } from "./codex-transport.mjs";
import { CodexSession, codexUsage, itemEvents } from "./codex-session.mjs";
import { compareCodexTurns } from "./codex-turn-order.mjs";

export { normalizeCodexEndpoint };
const requestKey = (id) => `${typeof id}:${id}`;
const decisionLabel = (decision) => {
  if (decision === "accept") return "允许一次";
  if (decision === "acceptForSession") return "本会话允许";
  if (decision === "decline") return "拒绝";
  if (decision === "cancel") return "拒绝并停止";
  if (decision?.acceptWithExecpolicyAmendment) return "允许并保存命令规则";
  if (decision?.applyNetworkPolicyAmendment) return "保存网络规则";
  return null;
};

/** DSH-compatible boundary; Codex-specific state never enters the DSH client. */
export class CodexClient extends EventEmitter {
  /** @type {CodexTransport | undefined} */
  transport;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  retryTimer;
  streams = new Set();
  sessions = new Map();
  attached = new Set();
  attaching = new Map();
  pending = new Map();
  live = new Map();
  emitted = new Set();
  diagnostics = new Set();
  clock = 0;
  metadataClock = 0;
  followClock = 0;
  generation = 0;
  closed = false;
  supportsBalance = false;
  pollInterval = 3000;
  stored = new Map();
  storedAt = 0;
  constructor(
    endpoint,
    {
      transportFactory = (url) => new CodexTransport(url),
      reconnectDelay = 1000,
      reconnectMaxDelay = 30000,
      random = Math.random,
    } = {},
  ) {
    super();
    this.endpoint = normalizeCodexEndpoint(endpoint);
    this.transportFactory = transportFactory;
    this.reconnectDelay = reconnectDelay;
    this.reconnectMaxDelay = reconnectMaxDelay;
    this.random = random;
    this.retryAttempt = 0;
  }
  frame(payload, rpcId) {
    this.emit("frame", { payload, rpcId });
  }
  session(thread, readVersion = Infinity) {
    let row = this.sessions.get(thread.id);
    if (!row) {
      row = new CodexSession(thread);
      row.createdVersion = ++this.metadataClock;
      row.metadataVersion = row.createdVersion;
      this.sessions.set(thread.id, row);
    } else if (row.metadataVersion <= readVersion) {
      row.thread = { ...row.thread, ...thread };
      row.metadataVersion = ++this.metadataClock;
    }
    return row;
  }
  setAttached(id, attached) {
    if (this.attached.has(id) === attached) return;
    if (attached) this.attached.add(id);
    else this.attached.delete(id);
    const row = this.sessions.get(id);
    if (row) row.followRevision = ++this.followClock;
  }
  async connect() {
    const transport = this.transportFactory(this.endpoint);
    this.transport = transport;
    const generation = ++this.generation;
    let established = false;
    this.emit("stream-start", { kind: "mux" });
    transport.on("message", (frame) => {
      if (!this.closed && this.transport === transport) this.receive(frame);
    });
    transport.on("disconnect", () => {
      if (!established || this.closed || this.transport !== transport) return;
      this.streams.clear();
      this.attached.clear();
      this.attaching.clear();
      this.pending.clear();
      this.live.clear();
      this.sessions.clear();
      this.listing = null;
      this.stored.clear();
      this.storedAt = 0;
      this.emitted.clear();
      this.emit("stream", {
        kind: "mux",
        connected: false,
        message: "Codex 连接中断，正在重连",
      });
      transport.close();
      this.retry();
    });
    const info = await transport.connect();
    if (this.closed || generation !== this.generation)
      throw new Error("Codex 连接已更换");
    established = true;
    this.retryAttempt = 0;
    this.streams.add("mux");
    this.streams.add("host");
    this.emit("stream", { kind: "mux", connected: true });
    return {
      version:
        info.userAgent?.match(
          /(?:Desktop|codex_cli_rs|codex)\/([^\s]+)/i,
        )?.[1] || "App Server",
      cwd: "",
      provider: "codex",
    };
  }
  retry() {
    if (this.closed || this.retryTimer) return;
    const ceiling = Math.min(
      this.reconnectMaxDelay,
      this.reconnectDelay * 2 ** Math.min(this.retryAttempt++, 30),
    );
    const delay = Math.max(
      1,
      Math.round(ceiling * (0.8 + 0.2 * this.random())),
    );
    this.emit("retry", { delay, attempt: this.retryAttempt });
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = undefined;
      try {
        await this.connect();
      } catch {
        this.transport?.close();
        this.retry();
      }
    }, delay);
  }
  compatibility(error, kind) {
    // JSON-RPC's method-not-found code is stable; wording is not. These
    // fallbacks only apply at the known resume/history call sites below.
    const matches =
      kind === "legacy-turns"
        ? error.code === -32601
        : error.code === -32600 &&
          /no rollout found|not materialized yet/i.test(error.message);
    if (matches || error.code === -32600 || error.code === -32601) {
      const key = `${kind}:${matches ? "fallback" : "unrecognized"}:${error.method}`;
      if (!this.diagnostics.has(key)) {
        this.diagnostics.add(key);
        // Never log message/data: upstream errors may contain user content.
        const diagnostic = {
          kind,
          fallback: matches,
          method: error.method,
          code: error.code,
        };
        this.emit("diagnostic", diagnostic);
        console.warn("[DSG Codex compatibility]", diagnostic);
      }
    }
    return matches;
  }
  async attach(id) {
    if (this.attached.has(id)) return;
    if (this.attaching.has(id)) return this.attaching.get(id);
    const transport = this.transport;
    if (!transport) throw new Error("Codex 未连接");
    const readVersion = this.metadataClock;
    const promise = transport
      .request("thread/resume", { threadId: id, excludeTurns: true })
      .catch((error) => {
        if (this.compatibility(error, "legacy-turns"))
          return transport.request("thread/resume", { threadId: id });
        throw error;
      })
      .then((result) => {
        if (this.transport !== transport || this.closed)
          throw new Error("Codex 连接已更换");
        const row = this.session(result.thread, readVersion);
        // A newer unload notification can arrive before this resume receipt.
        this.setAttached(id, row.thread.status?.type !== "notLoaded");
      })
      .catch((error) => {
        // Codex 0.154 cannot resume another client's unmaterialized draft.
        // Keep following other sessions and retry after its first message.
        if (this.compatibility(error, "unmaterialized-draft")) return;
        throw error;
      })
      .finally(() => {
        if (this.attaching.get(id) === promise) this.attaching.delete(id);
      });
    this.attaching.set(id, promise);
    return promise;
  }
  async list({ poll = false } = {}) {
    if (this.listing) return this.listing;
    const transport = this.transport;
    if (!transport) throw new Error("Codex 未连接");
    const listVersion = this.metadataClock;
    const promise = (async () => {
      const check = () => {
        if (this.transport !== transport || this.closed)
          throw new Error("Codex 连接已更换");
      };
      // Stored threads are readable without resuming them in this runtime.
      // Refresh metadata less often than live status; explicit refresh bypasses it.
      // Only a snapshot begun after a row's latest change can confirm absence.
      // Cached history has no such guarantee for this listing.
      let storedVersion = -1;
      const refreshStored = async () => {
        const snapshotVersion = this.metadataClock;
        const stored = new Map(),
          seen = new Set();
        let cursor;
        do {
          const readVersion = this.metadataClock;
          const page = await transport.request("thread/list", {
            limit: 100,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
            archived: false,
            useStateDbOnly: true,
            ...(cursor ? { cursor } : {}),
          });
          check();
          for (const thread of page.data) {
            if (thread.parentThreadId || thread.source?.subAgent) continue;
            stored.set(thread.id, thread);
            // Loaded threads get fresher metadata below.
            if (!this.attached.has(thread.id))
              this.session(thread, readVersion);
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw new Error("Codex 历史分页未前进");
          if (cursor) seen.add(cursor);
        } while (cursor);
        this.stored = stored;
        this.storedAt = Date.now();
        storedVersion = snapshotVersion;
      };
      if (!poll || Date.now() - this.storedAt >= 20000) await refreshStored();
      const ids = new Set();
      const seen = new Set();
      let cursor;
      do {
        const page = await transport.request("thread/loaded/list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const id of page.data) ids.add(id);
        check();
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Codex 会话分页未前进");
        if (cursor) seen.add(cursor);
      } while (cursor);
      // loaded/list is a snapshot. A subsequent read or notification can say
      // that a thread unloaded while other threads are still being queried.
      const isUnloaded = (id) =>
        !ids.has(id) ||
        this.sessions.get(id)?.thread.status?.type === "notLoaded";
      // Subscribe only to threads already loaded in THIS server. Other
      // desktop/CLI threads remain read-only, even if their logs are accessible.
      for (const id of ids) {
        const readVersion = this.metadataClock;
        const { thread } = await transport.request("thread/read", {
          threadId: id,
        });
        if (this.transport !== transport || this.closed)
          throw new Error("Codex 连接已更换");
        if (
          thread.parentThreadId ||
          (typeof thread.source === "object" && thread.source?.subAgent)
        )
          continue;
        this.session(thread, readVersion);
        if (!isUnloaded(id)) await this.attach(id);
      }
      // An owned draft can materialize and unload after even this listing's
      // history snapshot. Verify missing history against the latest changes.
      if (
        [...this.sessions.values()].some(
          (row) =>
            isUnloaded(row.thread.id) &&
            !this.stored.has(row.thread.id) &&
            row.metadataVersion > storedVersion,
        )
      )
        await refreshStored();
      // Verification is bounded to one retry. If another thread changes while
      // it is in flight, keep that row read-only until the next fresh snapshot.
      const historyConfirmsRemoval = (row) =>
        !this.stored.has(row.thread.id) && row.metadataVersion <= storedVersion;
      for (const id of this.sessions.keys())
        if (
          isUnloaded(id) &&
          this.sessions.get(id).createdVersion <= listVersion
        ) {
          this.setAttached(id, false);
          this.resolveThread(id);
          this.live.delete(id);
          if (historyConfirmsRemoval(this.sessions.get(id)))
            this.sessions.delete(id);
        }
      return {
        items: [...this.sessions.values()]
          .filter(
            (row) =>
              this.attached.has(row.thread.id) ||
              (isUnloaded(row.thread.id) && !historyConfirmsRemoval(row)),
          )
          .map((row) => ({
            sessionId: row.thread.id,
            cwd: row.thread.cwd,
            title:
              row.thread.name ||
              row.thread.preview?.slice(0, 80) ||
              "新的 Codex 对话",
            readOnly: !this.attached.has(row.thread.id),
            // A cached turn is valid only within the same subscription. A
            // task may start while this connection is not following a thread.
            followRevision: row.followRevision || 0,
            running:
              this.attached.has(row.thread.id) &&
              row.thread.status?.type === "active",
            blank: !row.thread.preview && !row.turns.size,
            updatedAt: row.thread.updatedAt * 1000,
            projections: { kind: "cached", values: row.values },
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    })().finally(() => {
      if (this.listing === promise) this.listing = null;
    });
    this.listing = promise;
    return promise;
  }
  snapshot(id, reset = false, previousTurns) {
    const row = this.sessions.get(id);
    if (row)
      this.frame({
        type: "session/history",
        sessionId: id,
        events: row.events(this.live.get(id)?.id),
        hasMore: !!row.cursor,
        ...(reset ? { reset: true } : {}),
        ...(previousTurns ? { previousTurns } : {}),
      });
  }
  readHistoryPage(transport, row, cursor) {
    const id = row.thread.id;
    return transport
      .request("thread/turns/list", {
        threadId: id,
        limit: 20,
        itemsView: "full",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      })
      .catch(async (error) => {
        if (
          !row.turns.size &&
          this.compatibility(error, "unmaterialized-draft")
        )
          return { data: [], nextCursor: null };
        if (this.compatibility(error, "legacy-turns")) {
          const { thread } = await transport.request("thread/read", {
            threadId: id,
            includeTurns: true,
          });
          return { data: [...thread.turns].reverse(), nextCursor: null };
        }
        throw error;
      });
  }
  async readActiveTurn(id) {
    const transport = this.transport;
    const row = this.sessions.get(id);
    if (!row) throw new Error("会话不在当前 Codex 服务中，请刷新列表");
    const followRevision = row.followRevision;
    const historyEpoch = row.historyEpoch;
    const revision = ++row.revision;
    const page = await this.readHistoryPage(transport, row);
    if (
      this.closed ||
      this.transport !== transport ||
      this.sessions.get(id) !== row ||
      row.followRevision !== followRevision
    )
      throw new Error("Codex 连接或会话已更换，请重新操作");
    if (row.historyEpoch !== historyEpoch)
      throw new Error("Codex 会话历史已更换，请重新操作");
    // Only the latest turn controls writes. Do not publish a partial display
    // window, change its pagination, or wait for unrelated older pages.
    // Concurrent live boundaries and newer successful reads take precedence.
    row.observeCurrentTurn(page.data[0], revision);
    return row.currentTurnId;
  }
  async history(id, older, previousTurn) {
    const transport = this.transport;
    const row = this.sessions.get(id);
    if (!row) throw new Error("会话不在当前 Codex 服务中，请刷新列表");
    const historyEpoch = row.historyEpoch;
    const cursor = row.cursor;
    const previous = previousTurn && {
      id: JSON.parse(previousTurn.key),
      startedAt: previousTurn.startedAt,
    };
    if (!older || cursor) {
      const revision = ++row.revision;
      // A live notification is not proof that the history between it and the
      // last saved page was loaded. Join against the last committed page head.
      const head = row.historyHead;
      const turns = [],
        seen = new Set();
      let nextCursor = older ? cursor : undefined;
      for (;;) {
        if (nextCursor && seen.has(nextCursor))
          throw new Error("Codex 消息历史分页未前进");
        if (nextCursor) seen.add(nextCursor);
        const page = await this.readHistoryPage(transport, row, nextCursor);
        if (
          this.closed ||
          this.transport !== transport ||
          this.sessions.get(id) !== row
        )
          throw new Error("Codex 连接或会话已更换，请重新操作");
        // Revert invalidates every old page, including a latest/older read
        // whose cursor happens to equal the cursor in the replacement history.
        // Reject instead of returning the reset cache: an empty cache is not
        // verified empty history and must not clear the caller's turn anchor.
        if (row.historyEpoch !== historyEpoch)
          throw new Error("Codex 会话历史已更换，请重新操作");
        // Only successful reads supersede earlier recent-page reads. Check each
        // page so a superseded gap read stops issuing requests immediately.
        if (older ? row.cursor !== cursor : revision < row.historyRevision)
          break;
        turns.push(...page.data);
        const joined = turns.some((turn) => turn.id === head);
        // Subscription recovery also needs proof that an unfamiliar head is
        // newer. For legacy/equal-time turns, search back to the previous head;
        // absence at the beginning is not evidence of new work.
        const needsAnchor =
          previous &&
          compareCodexTurns(turns[0], previous) === undefined &&
          !turns.some((turn) => turn.id === previous.id) &&
          !(joined && row.turns.has(previous.id));
        if (!older && page.nextCursor && ((head && !joined) || needsAnchor)) {
          nextCursor = page.nextCursor;
          continue;
        }
        // Commit a continuous window atomically: a failed gap read must not
        // publish a partial window or lose the cursor needed to retry it.
        row.mergePage([...turns].reverse(), revision, older, !page.nextCursor);
        if (!older) {
          row.historyRevision = revision;
          row.historyHead = turns[0]?.id;
        }
        // A joined refresh retains pagination progress, including an older
        // page loaded while this read was in flight. An empty cache has no
        // boundary to preserve; reaching the beginning also exhausts history.
        if (older || row.cursor === undefined || !head || !joined)
          row.cursor = page.nextCursor || null;
        break;
      }
    }
    const latest = row.turns.get(row.order.at(-1));
    const order = compareCodexTurns(latest, previous);
    const historical =
      previous &&
      latest &&
      latest.id !== previous.id &&
      (order === -1 || (order === undefined && !row.turns.has(previous.id)));
    return {
      events: row.events(this.live.get(id)?.id).map((event) => ({ event })),
      hasMore: !!row.cursor,
      replace: true,
      ...(historical ? { historical: true } : {}),
    };
  }
  async rpc(method, payload = {}) {
    const transport = this.transport;
    if (!transport) throw new Error("Codex 未连接");
    const checkConnection = () => {
      if (
        this.closed ||
        this.transport !== transport ||
        this.streams.size !== 2
      )
        throw new Error("Codex 连接已更换，请检查状态后重新操作");
    };
    if (method === "session.list") return this.list(payload);
    if (method === "session.history")
      return this.history(
        payload.sessionId,
        payload.beforeSeq !== undefined,
        payload.previousTurn,
      );
    if (method === "session.create") {
      const result = await transport.request("thread/start", {
        cwd: payload.cwd,
      });
      checkConnection();
      this.session(result.thread);
      this.setAttached(result.thread.id, true);
      return { sessionId: result.thread.id };
    }
    const id = payload.sessionId;
    const row = this.sessions.get(id);
    const followRevision = row?.followRevision;
    const historyEpoch = row?.historyEpoch;
    const checkWritable = () => {
      checkConnection();
      if (!row || !this.attached.has(id))
        throw new Error(
          "此会话仅支持查看，发送、取消和审批请在 Codex 原窗口处理",
        );
      if (
        this.sessions.get(id) !== row ||
        row.followRevision !== followRevision
      )
        throw new Error("Codex 会话已更换，请重新操作");
      if (row.historyEpoch !== historyEpoch)
        throw new Error("Codex 会话历史已更换，请重新操作");
      if (
        method === "session.prompt" &&
        row.thread.canAcceptDirectInput === false
      )
        throw new Error("此 Codex 会话暂不接受直接操作，请在原窗口处理");
    };
    checkWritable();
    if (method === "session.prompt") {
      // Read the active turn immediately before a write; steer includes a
      // precondition, so a completion race cannot send into a different turn.
      await this.readActiveTurn(id);
      checkWritable();
      const turnId = row.currentTurnId;
      const input = payload.content
        .filter((block) => block.type === "text")
        .map((block) => ({
          type: "text",
          text: block.text,
          text_elements: [],
        }));
      if (turnId) {
        await transport.request("turn/steer", {
          threadId: id,
          expectedTurnId: turnId,
          input,
        });
        return { command: { text: "补充消息已发送给当前 Codex 任务" } };
      }
      const result = await transport.request("turn/start", {
        threadId: id,
        input,
      });
      // A short turn can complete before the start RPC receipt arrives.
      // A successful receipt still acknowledges the accepted input, but cannot
      // recreate history that was reverted while it was in flight.
      if (row.historyEpoch === historyEpoch && !row.turns.has(result.turn.id))
        row.updateTurn(result.turn, true);
      return {};
    }
    if (method === "session.cancel") {
      await this.readActiveTurn(id);
      checkWritable();
      const turnId = row.currentTurnId;
      if (!turnId) throw new Error("当前没有正在运行的 Codex 任务");
      return transport.request("turn/interrupt", { threadId: id, turnId });
    }
    throw new Error(`Codex 不支持 ${method}`);
  }
  activity(id, key, event) {
    const unique = `${id}:${key}`;
    if (this.emitted.has(unique)) return;
    this.emitted.add(unique);
    this.frame({
      type: "session/event",
      sessionId: id,
      activityOnly: true,
      event: { ...event, seq: ++this.clock, time: Date.now() },
    });
  }
  resolve(key) {
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    this.frame({ type: "approval/resolved", approvalId: key });
    this.frame({ type: "question/resolved", questionRpcId: key });
  }
  resolveThread(id, turnId) {
    for (const [key, request] of this.pending)
      if (
        request.params.threadId === id &&
        (!turnId || request.params.turnId === turnId)
      )
        this.resolve(key);
  }
  startStream(id, itemId, text = "") {
    const live = { id: itemId, revision: 0, text };
    this.live.set(id, live);
    this.frame({
      type: "session/assistant-stream",
      sessionId: id,
      frame: { type: "start", attemptId: itemId, revision: 0 },
    });
    if (text)
      this.frame({
        type: "session/assistant-stream",
        sessionId: id,
        frame: {
          type: "chunk",
          attemptId: itemId,
          revision: ++live.revision,
          chunk: { type: "text-delta", text },
        },
      });
    return live;
  }
  receive(frame) {
    const p = frame.params || {},
      method = frame.method;
    if (frame.id !== undefined) {
      this.request(frame);
      return;
    }
    const id = p.threadId || p.thread?.id;
    if (method === "thread/started") {
      if (p.thread.parentThreadId) return;
      this.session(p.thread);
      this.frame({ type: "host/session-added", sessionId: id });
      return;
    }
    if (method === "serverRequest/resolved") {
      this.resolve(`${this.generation}:${requestKey(p.requestId)}`);
      return;
    }
    const row = this.sessions.get(id);
    if (!row) return;
    if (method === "thread/reverted") {
      // Keep known history identities across the cache reset. An earlier head
      // can have been read from history without ever being a live task here.
      const previousTurns = row.order.map((turn) => JSON.stringify(turn));
      row.resetHistory();
      this.live.delete(id);
      this.resolveThread(id);
      // Publish the invalidation even when no replacement page is available.
      // The open chat reloads immediately; background chats load on selection.
      this.snapshot(id, true, previousTurns);
      return;
    }
    if (method === "thread/status/changed") {
      row.metadataVersion = ++this.metadataClock;
      row.thread.status = p.status;
      if (p.status.type === "notLoaded") {
        this.setAttached(id, false);
        this.live.delete(id);
        this.resolveThread(id);
      }
      this.frame({
        type: "host/session-status",
        sessionId: id,
        running: p.status.type === "active",
      });
    }
    if (method === "thread/name/updated") {
      row.metadataVersion = ++this.metadataClock;
      row.thread.name = p.threadName;
      this.frame({ type: "host/session-added", sessionId: id });
    }
    if (method === "thread/tokenUsage/updated") {
      Object.assign(row.values, codexUsage(p.tokenUsage));
      for (const [key, value] of Object.entries(row.values))
        this.frame({
          type: "session/projection",
          sessionId: id,
          key,
          value,
          seq: ++this.clock,
        });
    }
    if (method === "turn/started" || method === "turn/completed") {
      const key = `${p.turn.id}:${method}`;
      // Replays must not advance metadata or clear a newer turn's stream.
      // Deduplicating only the emitted activity would still corrupt the cache
      // and make an in-flight list discard its correct runtime snapshot.
      if (this.emitted.has(`${id}:${key}`)) return;
      row.metadataVersion = ++this.metadataClock;
      row.updateTurn(p.turn, true);
      const started = method === "turn/started";
      row.thread.status = { type: started ? "active" : "idle" };
      this.activity(id, key, {
        type: started ? "turn/start" : "turn/end",
        data: {
          turn: p.turn.id,
          ...(Number.isFinite(p.turn.startedAt)
            ? { startedAt: p.turn.startedAt }
            : {}),
          reason: { kind: p.turn.status, error: p.turn.error },
        },
      });
      if (!started) {
        this.live.delete(id);
        this.resolveThread(id, p.turn.id);
      }
      this.snapshot(id);
    }
    if (method === "item/started" || method === "item/completed") {
      row.updateItem(p.turnId, p.item);
      const completed = method === "item/completed";
      if (p.item.type === "agentMessage") {
        if (!completed) {
          this.startStream(id, p.item.id, p.item.text || "");
        } else this.live.delete(id);
      }
      const events = itemEvents(p.item, p.turnId);
      for (const event of events) {
        if (event.type === "assistant/message" && !completed) continue;
        if (event.type === "tool/result" && !completed) continue;
        this.activity(id, `${p.item.id}:${event.type}`, event);
      }
      this.snapshot(id);
    }
    if (method === "item/agentMessage/delta") {
      let live = this.live.get(id);
      if (live?.id !== p.itemId) {
        live = this.startStream(
          id,
          p.itemId,
          row.turns.get(p.turnId)?.items.get(p.itemId)?.text || "",
        );
      }
      live.text += p.delta;
      row.updateItem(p.turnId, {
        id: p.itemId,
        type: "agentMessage",
        text: live.text,
      });
      this.frame({
        type: "session/assistant-stream",
        sessionId: id,
        frame: {
          type: "chunk",
          attemptId: p.itemId,
          revision: ++live.revision,
          chunk: { type: "text-delta", text: p.delta },
        },
      });
    }
    if (method === "error" && !p.willRetry)
      this.frame({
        type: "host/agent-error",
        sessionId: id,
        message: p.error?.message || "Codex 执行失败",
      });
  }
  request(frame) {
    const p = frame.params,
      key = `${this.generation}:${requestKey(frame.id)}`;
    if (!p?.threadId || this.pending.has(key)) return;
    const request = {
      ...frame,
      choices:
        /** @type {{decision: string | Record<string, unknown>}[]} */ ([]),
    };
    const payload = {
      sessionId: p.threadId,
      type: "approval/requested",
      approvalId: key,
      toolName: p.command || p.itemId || frame.method,
      reason: p.reason || "",
      choices:
        /** @type {{value: string, label: string | null, detail?: string}[]} */ ([]),
    };
    if (
      ["item/tool/requestUserInput", "tool/requestUserInput"].includes(
        frame.method,
      )
    ) {
      payload.type = "question/requested";
      payload.questions = p.questions;
    } else if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(frame.method)
    ) {
      const decisions = p.availableDecisions ?? [
        "accept",
        "acceptForSession",
        "decline",
        "cancel",
        ...(p.proposedExecpolicyAmendment
          ? [
              {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: p.proposedExecpolicyAmendment,
                },
              },
            ]
          : []),
      ];
      request.choices = decisions
        .filter((decision) => decisionLabel(decision))
        .map((decision) => ({ decision }));
      payload.choices = request.choices.map((choice, i) => ({
        value: `choice-${i}`,
        label: decisionLabel(choice.decision),
        detail:
          typeof choice.decision === "object"
            ? JSON.stringify(choice.decision, null, 2)
            : undefined,
      }));
      if (p.cwd) payload.reason = `${payload.reason}\n目录：${p.cwd}`.trim();
    } else if (frame.method === "item/permissions/requestApproval") {
      payload.toolName = "请求额外权限";
      payload.reason = `${p.reason || ""}\n${JSON.stringify(p.permissions, null, 2)}`;
      request.choices = [
        { permissions: {}, scope: "turn" },
        { permissions: p.permissions, scope: "turn" },
        { permissions: p.permissions, scope: "session" },
      ];
      payload.choices = ["拒绝", "本轮允许", "本会话允许"].map((label, i) => ({
        value: `choice-${i}`,
        label,
      }));
    } else {
      // Other clients can answer specialized MCP/device-auth requests. Never
      // auto-approve or decline a request merely because this UI can't render it.
      payload.reason = `${p.message || p.reason || ""}\n请在 Codex 原窗口处理此类请求（${frame.method}）。`;
    }
    this.pending.set(key, request);
    this.frame(payload, key);
  }
  async respond(key, value) {
    const request = this.pending.get(key);
    if (!request || request.params.threadId !== value.sessionId)
      throw new Error("此 Codex 请求已失效");
    let result;
    if (
      ["item/tool/requestUserInput", "tool/requestUserInput"].includes(
        request.method,
      )
    ) {
      const answers = {};
      for (const question of request.params.questions) {
        const answer = value.answer?.answers?.find(
          (entry) => entry.id === question.id,
        );
        const texts = [
          ...(answer?.selected || []),
          ...(answer?.custom?.trim() ? [answer.custom.trim()] : []),
        ];
        if (!texts.length || texts.some((text) => typeof text !== "string"))
          throw new Error("请回答所有问题");
        answers[question.id] = { answers: texts };
      }
      result = { answers };
    } else {
      const match = /^choice-(\d+)$/.exec(value.outcome || "");
      result = match && request.choices[Number(match[1])];
      if (!result) throw new Error("无效的 Codex 审批决定");
    }
    const transport = this.transport;
    if (!transport) throw new Error("Codex 未连接");
    await transport.send({ id: request.id, result });
    this.resolve(key);
  }
  close() {
    this.closed = true;
    if (this.retryTimer) clearNodeTimeout(this.retryTimer);
    this.transport?.close();
    this.removeAllListeners();
  }
}
