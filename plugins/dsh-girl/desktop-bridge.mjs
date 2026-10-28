import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createBalanceReader } from "../dsh-girl-bridge/index.mjs";

/** Compatibility boundary for Desktop 0.2: one private owner Peer, never an exposed Host API. */
export async function desktopBridge(ctx) {
  const gateway = ctx.get("typertGateway");
  const peer = ctx.connection.createPeer({ principal: { kind: "owner" } });
  const lifetime = new AbortController();
  const token = randomBytes(32).toString("hex");
  const readBalance = createBalanceReader(ctx.credentials);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  const channels = new Map();
  const disposers = [];
  const pending = new Map();
  let lastError = "";
  const authorized = (req) => {
    const value = req.headers["x-dsg-token"];
    return (
      !req.headers.origin &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(token))
    );
  };
  const send = (socket, payload, rpcId = randomBytes(12).toString("hex")) => {
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 8 * 1024 * 1024) return socket.terminate();
      socket.send(JSON.stringify({ type: "server-request", rpcId, payload }));
    }
  };
  const emit = (kind, payload) => {
    for (const socket of channels.get(kind) || []) send(socket, payload);
  };
  const invoke = (method, request) =>
    gateway.invoke({
      namespace: "session",
      method,
      args: { [method === "list" ? "_request" : "request"]: request },
      peer,
      signal: lifetime.signal,
    });
  async function models(request) {
    const [catalog, block] = await Promise.all([
      gateway.invoke({
        namespace: "session",
        method: "modelCatalog",
        args: {},
        peer,
        signal: lifetime.signal,
      }),
      invoke("projections", { sessionId: request.sessionId }),
    ]);
    if (
      !catalog ||
      !Array.isArray(catalog.groups) ||
      !Array.isArray(catalog.failures)
    )
      throw new Error("Desktop 模型目录不兼容");
    const selection = block?.values?.modelSelection;
    const current = selection?.next || selection?.lastUsed || catalog.default;
    if (
      !current ||
      typeof current.provider !== "string" ||
      typeof current.model !== "string"
    )
      throw new Error("Desktop 未返回会话模型");
    return {
      current,
      routable:
        Array.isArray(catalog.routableProviders) &&
        catalog.routableProviders.includes(current.provider),
      groups: catalog.groups,
      failures: catalog.failures,
    };
  }
  async function history(request) {
    const address = { kind: "session", sessionId: request.sessionId };
    const control = new AbortController();
    const source = await gateway.stream({
      namespace: "session",
      method: "follow",
      args: { request: { address, maxMessages: request.maxMessages || 40 } },
      peer,
      signal: AbortSignal.any([lifetime.signal, control.signal]),
    });
    const iterator = source[Symbol.asyncIterator]();
    let snapshot;
    try {
      snapshot = (await iterator.next()).value;
    } finally {
      control.abort();
      await iterator.return?.();
    }
    if (snapshot?.type !== "snapshot")
      throw new Error("Desktop 会话快照不兼容");
    if (request.beforeSeq !== undefined) {
      const page = await invoke("page", {
        address,
        throughSeq: snapshot.cursor,
        beforeSeq: request.beforeSeq,
        maxMessages: request.maxMessages || 40,
      });
      return {
        events: page.records,
        hasMore: page.hasMore,
        projections: snapshot.projections,
      };
    }
    return {
      events: snapshot.records,
      hasMore: snapshot.hasMore,
      projections: snapshot.projections,
    };
  }
  const respond = async (rpcId, value) => {
    const entry = pending.get(rpcId);
    if (!entry || entry.sessionId !== value?.sessionId)
      return { accepted: false, reason: "not-pending" };
    let answer;
    if (entry.kind === "approval") {
      if (
        value.approvalId !== entry.approvalId ||
        !["allowed-once", "rejected"].includes(value.outcome)
      )
        throw new Error("无效许可决定");
      answer = value.outcome;
    } else answer = value.answer;
    const result = await gateway.dispatchRpc(
      "$events/result",
      {
        args: {
          clientId: entry.clientId,
          eventId: rpcId,
          outcome: { kind: "result", value: answer },
        },
      },
      lifetime.signal,
      peer,
    );
    if (!result.ok)
      throw new Error(result.error?.message || "Desktop 未接受回答");
    pending.delete(rpcId);
    return { accepted: true };
  };
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req))
      return reply(403, { error: "桌宠 private connection required" });
    if (req.method === "GET" && req.url === "/dsh-girl/balance.json")
      return reply(200, await readBalance());
    if (req.method !== "POST" || !req.url?.startsWith("/api/"))
      return reply(404, {});
    let message;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return reply(413, {});
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks));
      if (req.url === "/api/respond")
        return reply(200, await respond(message.rpcId, message.result?.value));
      const { method, payload = {}, rpcId } = message;
      if (
        req.url !== "/api/" + method ||
        message.type !== "client-request" ||
        typeof rpcId !== "string"
      )
        return reply(400, {});
      let value;
      if (method === "host.describe")
        value = { version: "desktop-0.2", cwd: process.cwd() };
      else if (method === "session.models") value = await models(payload);
      else if (method === "session.history") value = await history(payload);
      else if (
        [
          "session.list",
          "session.create",
          "session.selectModel",
          "session.prompt",
          "session.cancel",
        ].includes(method)
      )
        value = await invoke(
          method.slice(8),
          method === "session.prompt"
            ? { ...payload, requestId: rpcId }
            : payload,
        );
      else throw new Error("桌宠不支持此 Desktop 操作");
      reply(200, {
        type: "server-response",
        rpcId,
        result: { ok: true, value },
      });
    } catch (error) {
      lastError = error.message;
      reply(200, {
        type: "server-response",
        rpcId: message?.rpcId,
        result: { ok: false, error: { message: error.message } },
      });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const kind =
      req.url === "/api/events.mux"
        ? "mux"
        : req.url === "/api/events.host"
          ? "host"
          : null;
    if (!kind || !authorized(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const group = channels.get(kind) || new Set();
      channels.set(kind, group);
      group.add(ws);
      ws.on("error", () => {});
      ws.once("close", () => group.delete(ws));
      if (kind === "mux") {
        void events(ws);
        void projections(ws);
      }
    });
  });
  async function projections(socket) {
    const control = new AbortController();
    const closed = () => control.abort();
    socket.once("close", closed);
    const signal = AbortSignal.any([lifetime.signal, control.signal]);
    try {
      const source = await gateway.stream({
        namespace: "session",
        method: "control",
        args: {},
        peer,
        signal,
      });
      for await (const frame of source) {
        if (signal.aborted) break;
        if (frame.type === "baseline")
          send(socket, {
            type: "session/projections",
            projections: frame.value.projections,
          });
        else if (frame.type === "projection")
          send(socket, { ...frame, type: "session/projection" });
      }
      if (!signal.aborted) throw new Error("Desktop statistics stream ended");
    } catch (error) {
      if (!signal.aborted) {
        lastError = error.message;
        // Reopen mux to obtain a fresh baseline instead of silently going stale.
        socket.close(1011, "Desktop statistics stream unavailable");
      }
    } finally {
      control.abort();
      socket.removeListener("close", closed);
    }
  }
  async function events(socket) {
    const control = new AbortController();
    socket.once("close", () => control.abort());
    const signal = AbortSignal.any([lifetime.signal, control.signal]);
    let clientId;
    try {
      const source = await gateway.wireStream.open(
        "$events",
        { args: {} },
        undefined,
        peer,
        signal,
      );
      for await (const frame of source) {
        if (frame.type === "ready") clientId = frame.clientId;
        else if (frame.type === "emit") {
          const [id, value] = frame.args;
          const types = {
            "api-session/status": "host/session-status",
            "api-session/error": "host/agent-error",
            "api-session/added": "host/session-added",
            "api-session/removed": "host/session-removed",
          };
          if (types[frame.event])
            send(socket, {
              type: types[frame.event],
              sessionId: id?.sessionId || id,
              ...(frame.event === "api-session/status"
                ? { running: value }
                : {}),
              ...(frame.event === "api-session/error"
                ? { message: value }
                : {}),
            });
        } else if (frame.type === "waterfall") {
          const approval = frame.event === "approval/request";
          if (!approval && frame.event !== "user-questions/request") continue;
          const request = frame.request;
          pending.set(frame.eventId, {
            clientId,
            sessionId: frame.agentId,
            kind: approval ? "approval" : "question",
            approvalId: frame.eventId,
          });
          send(
            socket,
            {
              ...request,
              ...(approval ? { approvalId: frame.eventId } : {}),
              sessionId: frame.agentId,
              type: approval ? "approval/requested" : "question/requested",
            },
            frame.eventId,
          );
        } else if (frame.type === "cancel") {
          const entry = pending.get(frame.eventId);
          pending.delete(frame.eventId);
          if (entry)
            send(socket, {
              type:
                entry.kind === "approval"
                  ? "approval/resolved"
                  : "question/resolved",
              approvalId: entry.approvalId,
              questionRpcId: frame.eventId,
              sessionId: entry.sessionId,
            });
        }
      }
      if (!signal.aborted) throw new Error("Desktop event stream ended");
    } catch (error) {
      if (!signal.aborted) {
        lastError = error.message;
        socket.close(1011, "Desktop event stream unavailable");
      }
    } finally {
      control.abort();
      for (const [id, entry] of pending)
        if (entry.clientId === clientId) pending.delete(id);
    }
  }
  disposers.push(
    ctx.on(
      "session/event",
      (session, event) =>
        emit("mux", { type: "session/event", sessionId: session.id, event }),
      { global: true },
    ),
  );
  // Durable events drive history and completion. Cursorless chunks are forwarded separately.
  disposers.push(
    ctx.on(
      "agent/assistant-stream",
      ({ agent, frame }) => {
        emit("mux", {
          type: "session/assistant-stream",
          sessionId: agent.session.id,
          frame,
        });
      },
      { global: true },
    ),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    token,
    get error() {
      return lastError;
    },
    async dispose() {
      lifetime.abort();
      pending.clear();
      for (const dispose of disposers) dispose();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        peer.dispose(),
      ]);
    },
  };
}
