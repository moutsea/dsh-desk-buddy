import { WebSocketServer } from "ws";

export async function createCodexHost({ persistEmptyThreads = true } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const calls = [],
    responses = [],
    sessions = new Map();
  let serial = 0;
  const host = {
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    calls,
    responses,
    sessions,
    handler: null,
    storedThreads() {
      return [...sessions.values()]
        .filter(
          (thread) =>
            persistEmptyThreads || thread.preview || thread.turns.length,
        )
        .map((thread) => ({ ...thread, turns: [] }));
    },
    notify(method, params, id) {
      for (const socket of server.clients)
        socket.send(
          JSON.stringify({
            method,
            params,
            ...(id === undefined ? {} : { id }),
          }),
        );
    },
    disconnect() {
      for (const socket of server.clients) socket.terminate();
    },
    async close() {
      host.disconnect();
      await new Promise((resolve) => server.close(resolve));
    },
    add(id = "thread-1") {
      const thread = {
        id,
        cwd: "/tmp/dsg-codex-test",
        name: "Codex 联调",
        preview: "测试",
        updatedAt: 1700000000,
        status: { type: "idle" },
        turns: [],
      };
      sessions.set(id, thread);
      return thread;
    },
    start(id = "thread-1") {
      const thread = sessions.get(id),
        turn = { id: `turn-${++serial}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      thread.status = { type: "active" };
      host.notify("turn/started", { threadId: id, turn });
      return turn;
    },
    item(threadId, turn, item, completed = false) {
      const index = turn.items.findIndex((i) => i.id === item.id);
      if (index < 0) turn.items.push(item);
      else turn.items[index] = item;
      host.notify(completed ? "item/completed" : "item/started", {
        threadId,
        turnId: turn.id,
        item,
      });
    },
    finish(id, turn, status = "completed") {
      turn.status = status;
      sessions.get(id).status = { type: "idle" };
      host.notify("turn/completed", {
        threadId: id,
        turn: { ...turn, items: [] },
      });
    },
  };
  server.on("connection", (socket) =>
    socket.on("message", async (raw) => {
      const frame = JSON.parse(raw.toString());
      if (!frame.method) {
        responses.push(frame);
        return;
      }
      calls.push(frame);
      if (frame.id === undefined) return;
      let result;
      if (host.handler) {
        const value = await host.handler(frame, socket);
        if (value === true) return;
      }
      const p = frame.params || {},
        thread = sessions.get(p.threadId);
      switch (frame.method) {
        case "initialize":
          result = { userAgent: "codex-test" };
          break;
        case "thread/loaded/list":
          result = {
            data: [...sessions.values()]
              .filter((t) => t.status.type !== "notLoaded")
              .map((t) => t.id),
            nextCursor: null,
          };
          break;
        case "thread/list":
          result = {
            data: host.storedThreads(),
            nextCursor: null,
          };
          break;
        case "thread/read":
        case "thread/resume":
          result = { thread: { ...thread, turns: [] } };
          break;
        case "model/list":
          result = {
            data: [
              {
                id: "preset-test-low",
                model: "gpt-test-low",
                displayName: "GPT Test Low",
                description: "快速模型",
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "快速" },
                  { reasoningEffort: "high", description: "深入" },
                ],
              },
              {
                id: "preset-test-high",
                model: "gpt-test-high",
                displayName: "GPT Test High",
                description: "深入模型",
                hidden: false,
                isDefault: false,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  { reasoningEffort: "high", description: "深入" },
                ],
              },
            ],
            nextCursor: null,
          };
          break;
        case "thread/settings/update":
          if (!thread) {
            socket.send(
              JSON.stringify({
                id: frame.id,
                error: { code: -32000, message: "unknown thread" },
              }),
            );
            return;
          }
          thread.model = p.model;
          if (p.effort) thread.reasoningEffort = p.effort;
          result = {};
          break;
        case "thread/start": {
          let id;
          do id = `thread-${++serial}`;
          while (sessions.has(id));
          result = {
            thread: {
              ...host.add(id),
              cwd: p.cwd,
              preview: "",
            },
          };
          sessions.set(result.thread.id, result.thread);
          break;
        }
        case "thread/turns/list":
          result = { data: [...thread.turns].reverse(), nextCursor: null };
          break;
        case "turn/start": {
          const turn = host.start(p.threadId);
          host.item(
            p.threadId,
            turn,
            { id: `user-${serial}`, type: "userMessage", content: p.input },
            true,
          );
          result = { turn };
          break;
        }
        case "turn/steer":
          result = { turnId: p.expectedTurnId };
          break;
        case "turn/interrupt":
          host.finish(
            p.threadId,
            thread.turns.find((t) => t.id === p.turnId),
            "interrupted",
          );
          result = {};
          break;
        default:
          socket.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32601, message: "unsupported" },
            }),
          );
          return;
      }
      socket.send(JSON.stringify({ id: frame.id, result }));
    }),
  );
  return host;
}
