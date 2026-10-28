import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");

export function normalizeCodexEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入 Codex 本机 WebSocket 地址");
  }
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Codex 地址必须是本机 ws://127.0.0.1:端口 或 ws://[::1]:端口",
    );
  return url.origin;
}

// One connection owns its request IDs. Mutations are never retried, including
// responses to approvals: a missing receipt is not evidence of rejection.
export class CodexTransport extends EventEmitter {
  pending = new Map();
  serial = 0;
  closed = false;
  constructor(endpoint, { timeout = 30000 } = {}) {
    super();
    this.endpoint = normalizeCodexEndpoint(endpoint);
    this.timeout = timeout;
  }
  async connect() {
    if (this.closed) throw new Error("Codex 连接已关闭");
    try {
      const socket = new WebSocket(this.endpoint, {
        maxPayload: 32 * 1024 * 1024,
      });
      this.socket = socket;
      socket.on("message", (raw) => {
        if (this.socket !== socket) return;
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          socket.close(1002);
          return;
        }
        if (frame.method) this.emit("message", frame);
        else {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error) {
            /** @type {Error & {code?: number, method?: string, data?: unknown}} */
            const error = new Error(frame.error.message || "Codex 请求失败");
            error.code = frame.error.code;
            error.method = pending.method;
            error.data = frame.error.data;
            pending.reject(error);
          } else pending.resolve(frame.result);
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        if (this.socket !== socket) return;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Codex 连接断开；请查看任务状态后再操作"));
        }
        this.pending.clear();
        if (!this.closed) this.emit("disconnect");
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("Codex 连接超时"));
        }, this.timeout);
        const finish = (error) => {
          clearTimeout(timer);
          socket.off("open", opened);
          socket.off("error", failed);
          socket.off("close", failed);
          error ? reject(error) : resolve(undefined);
        };
        const opened = () => finish();
        const failed = () =>
          finish(new Error("未找到 Codex 服务，请先启动共享 App Server"));
        socket.once("open", opened);
        socket.once("error", failed);
        socket.once("close", failed);
      });
      const info = await this.request("initialize", {
        clientInfo: { name: "dsh_desk_buddy", title: "DSG", version },
        capabilities: { experimentalApi: true },
      });
      await this.send({ method: "initialized" });
      return info;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  send(frame) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.socket?.readyState !== WebSocket.OPEN)
        return reject(new Error("Codex 未连接"));
      this.socket.send(JSON.stringify(frame), (error) =>
        error ? reject(error) : resolve(undefined),
      );
    });
  }
  request(method, params = {}) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时；请求可能已执行，请先检查状态`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex 连接已关闭"));
    }
    this.pending.clear();
    this.socket?.terminate();
    this.removeAllListeners();
  }
}
