import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// An explicitly isolated protocol fixture; no model provider or credentials.
export async function createFixture({ historyPageSize, beforeRpcReply } = {}) {
  const streams = { mux: new Set(), host: new Set() },
    sessions = new Map(),
    pending = new Map(),
    calls = [],
    timers = new Set();
  const modelCatalog = [
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      reasoning: {
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "low",
      },
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      reasoning: {
        efforts: [{ id: "high", name: "High" }],
        defaultEffort: "high",
      },
    },
  ];
  let disconnected = false;
  let streamsAvailable = true;
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  function push(kind, payload, rpcId = crypto.randomUUID()) {
    const wire = JSON.stringify({
      type: "server-request",
      rpcId,
      method: "events." + kind,
      payload,
    });
    for (const socket of streams[kind])
      if (socket.readyState === WebSocket.OPEN) socket.send(wire);
  }
  function event(id, type, data) {
    const row = sessions.get(id),
      entry = {
        seq: row.events.length,
        time: Date.now(),
        type,
        data,
        ...(["user/message", "assistant/message"].includes(type)
          ? { surfaceOp: "append" }
          : {}),
      };
    row.events.push(entry);
    push("mux", { type: "session/event", sessionId: id, event: entry });
    return entry;
  }
  function finish(id, reason = { kind: "completed" }) {
    const row = sessions.get(id);
    row.running = false;
    if (reason.kind === "completed")
      event(id, "assistant/message", {
        turn: 1,
        step: 0,
        message: {
          content: [{ type: "text", text: "检查完成，项目已经准备好。" }],
        },
      });
    event(id, "turn/end", { turn: 1, reason });
    push("host", {
      type: "host/session-status",
      sessionId: id,
      running: false,
    });
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path.startsWith("/api/events.")) {
      response.writeHead(426);
      response.end("upgrade required");
      return;
    }
    if (path === "/dsh-girl/balance.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          balances: [{ currency: "CNY", total: 12.34 }],
          updatedAt: Date.now(),
        }),
      );
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path, ...body });
    let value = {},
      error;
    if (path === "/api/host.describe")
      value = {
        version: "fixture-1",
        cwd: "/tmp/dsh-girl-test-project",
        home: "/tmp",
        attachedSessions: sessions.size,
        canOpenPath: false,
      };
    else if (path === "/api/session.list")
      value = {
        items: [...sessions.values()].map(
          ({ events, listProjections, ...row }) => ({
            ...row,
            ...(listProjections ? { projections: listProjections } : {}),
          }),
        ),
      };
    else if (path === "/api/session.create") {
      const id = body.payload.sessionId || crypto.randomUUID();
      sessions.set(id, {
        sessionId: id,
        cwd: body.payload.cwd,
        blank: true,
        updatedAt: Date.now(),
        running: false,
        events: [],
        projections: {
          asOfSeq: -1,
          values: { title: { title: "测试项目任务" } },
        },
      });
      value = { sessionId: id };
    } else if (path === "/api/session.history") {
      const row = sessions.get(body.payload.sessionId);
      const matching = row.events.filter(
        (item) =>
          body.payload.beforeSeq === undefined ||
          item.seq < body.payload.beforeSeq,
      );
      value = {
        events: (historyPageSize
          ? matching.slice(-historyPageSize)
          : matching
        ).map((event) => ({ event })),
        hasMore: historyPageSize ? matching.length > historyPageSize : false,
        ...(row.projections ? { projections: row.projections } : {}),
      };
    } else if (path === "/api/session.models") {
      const row = sessions.get(body.payload.sessionId);
      if (!row) error = { code: "not-found", message: "未知会话" };
      else
        value = {
          current: row.model || {
            provider: "deepseek",
            model: "deepseek-v4.1-flash",
          },
          routable: true,
          groups: [{ id: "deepseek", name: "DeepSeek", models: modelCatalog }],
          failures: [],
        };
    } else if (path === "/api/session.selectModel") {
      const row = sessions.get(body.payload.sessionId);
      if (!row) error = { code: "not-found", message: "未知会话" };
      else {
        row.model = {
          provider: body.payload.provider,
          model: body.payload.model,
          ...(body.payload.reasoningEffort
            ? { reasoningEffort: body.payload.reasoningEffort }
            : {}),
        };
        row.projections = row.projections || { asOfSeq: -1, values: {} };
        row.projections = {
          asOfSeq: row.projections.asOfSeq + 1,
          modelSelectionSeq: row.projections.asOfSeq + 1,
          values: {
            ...row.projections.values,
            modelSelection: { next: row.model },
          },
        };
        push("mux", {
          type: "session/projection",
          sessionId: body.payload.sessionId,
          key: "modelSelection",
          value: { next: row.model },
          seq: row.projections.modelSelectionSeq,
        });
        value = { selected: row.model };
      }
    } else if (path === "/api/session.prompt") {
      const id = body.payload.sessionId,
        row = sessions.get(id),
        text = body.payload.content[0].text;
      if (text === "触发失败")
        error = { code: "test-error", message: "测试：拒绝此消息" };
      else {
        row.running = true;
        row.blank = false;
        push("host", {
          type: "host/session-status",
          sessionId: id,
          running: true,
        });
        event(id, "turn/start", { turn: 1 });
        event(id, "user/message", {
          role: "user",
          source: { kind: "user", rpcId: body.rpcId },
          content: [{ type: "text", text }],
        });
        later(() => {
          if (!row.running) return;
          event(id, "assistant/chunk", {
            turn: 1,
            step: 0,
            chunk: { type: "text-delta", text: "正在检查项目…", index: 0 },
          });
          if (text.includes("停止测试")) return;
          event(id, "tool/call", {
            turn: 1,
            step: 0,
            name: "fs.read",
            arguments: "{}",
          });
          const payload = {
            type: "approval/requested",
            sessionId: id,
            approvalId: "approval-test",
            toolName: "fs.read",
            reason: "测试服务请求读取项目。",
          };
          pending.set("approval-rpc", payload);
          push("mux", payload, "approval-rpc");
        }, 120);
        value = { accepted: true };
      }
    } else if (path === "/api/session.cancel") {
      const id = body.payload.sessionId;
      for (const [rpcId, payload] of pending)
        if (payload.sessionId === id) {
          pending.delete(rpcId);
          push("mux", {
            type: "approval/resolved",
            sessionId: id,
            approvalId: payload.approvalId,
            outcome: "cancelled",
          });
        }
      finish(id, { kind: "aborted", reason: "user" });
      value = { accepted: true };
    } else if (path === "/api/respond") {
      const item = pending.get(body.rpcId);
      if (!item) {
        response.end(
          JSON.stringify({ accepted: false, reason: "not-pending" }),
        );
        return;
      }
      pending.delete(body.rpcId);
      const id = item.sessionId;
      if (item.type === "approval/requested") {
        push("mux", {
          type: "approval/resolved",
          sessionId: id,
          approvalId: item.approvalId,
          outcome: body.result.value.outcome,
        });
        if (body.result.value.outcome === "rejected")
          finish(id, { kind: "blocked" });
        else {
          event(id, "tool/result", {
            turn: 1,
            step: 0,
            message: { content: [{ type: "text", text: "read ok" }] },
          });
          const payload = {
            type: "question/requested",
            sessionId: id,
            questions: [
              {
                id: "next",
                question: "下一步做什么？",
                options: [{ label: "继续检查" }, { label: "先到这里" }],
              },
            ],
          };
          pending.set("question-rpc", payload);
          push("mux", payload, "question-rpc");
        }
      } else {
        push("mux", {
          type: "question/resolved",
          sessionId: id,
          questionRpcId: body.rpcId,
          outcome: "answered",
        });
        later(() => finish(id), 100);
      }
      response.end(JSON.stringify({ accepted: true }));
      return;
    } else error = { code: "not-found", message: "unknown method" };
    await beforeRpcReply?.({ method: body.method, value });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: error ? { ok: false, error } : { ok: true, value },
      }),
    );
  });
  const websocket = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const kind =
      request.url === "/api/events.mux"
        ? "mux"
        : request.url === "/api/events.host"
          ? "host"
          : null;
    if (!kind || !streamsAvailable) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (connection) => {
      streams[kind].add(connection);
      connection.on("close", () => streams[kind].delete(connection));
      if (kind === "mux")
        for (const [rpcId, payload] of pending)
          connection.send(
            JSON.stringify({
              type: "server-request",
              rpcId,
              method: "events.mux",
              payload,
            }),
          );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    calls,
    sessions,
    pending,
    event,
    push,
    fragment: (kind, payload) => {
      const buffer = Buffer.from(
        JSON.stringify({
          type: "server-request",
          rpcId: "fragment",
          method: "events." + kind,
          payload,
        }),
      );
      for (const socket of streams[kind]) {
        const position = buffer.indexOf(Buffer.from("你")) + 1;
        socket.send(buffer.subarray(0, position), {
          fin: false,
          binary: false,
        });
        socket.send(buffer.subarray(position), { fin: true, binary: false });
      }
    },
    dropStreams: () => {
      for (const group of Object.values(streams))
        for (const socket of group) socket.close();
      disconnected = true;
    },
    setStreamsAvailable: (value) => {
      streamsAvailable = value;
    },
    get disconnected() {
      return disconnected;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const group of Object.values(streams))
        for (const socket of group) socket.terminate();
      websocket.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
