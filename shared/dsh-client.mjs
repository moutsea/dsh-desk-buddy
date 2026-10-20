import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("请使用本机地址，例如 http://127.0.0.1:3080");
  }
  return url.origin;
}

export class DshClient extends EventEmitter {
  constructor(endpoint, { token } = {}) {
    super();
    this.endpoint = normalizeEndpoint(endpoint);
    this.headers = token ? { "X-DSG-Token": token } : {};
    this.controller = new AbortController();
    this.streams = new Set();
  }
  async request(path, init = {}) {
    const response = await fetch(this.endpoint + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(15000),
      ]),
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new Error(`DSH 返回 HTTP ${response.status}，请检查服务地址和版本`);
    return response.json();
  }
  async rpc(method, payload = {}) {
    const rpcId = randomUUID();
    const reply = await this.request("/api/" + method, {
      method: "POST",
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    });
    if (
      reply.type !== "server-response" ||
      reply.rpcId !== rpcId ||
      typeof reply.result?.ok !== "boolean"
    )
      throw new Error("DSH 协议响应不兼容");
    if (!reply.result.ok)
      throw new Error(
        reply.result.error?.message ||
          reply.result.error?.code ||
          "DSH 请求失败",
      );
    return reply.result.value;
  }
  async connect() {
    const host = await this.rpc("host.describe");
    if (typeof host?.version !== "string" || typeof host?.cwd !== "string")
      throw new Error("无法识别 DSH 宿主信息");
    this.loops = ["mux", "host"].map((kind) => this.stream(kind));
    return host;
  }
  async respond(rpcId, value) {
    const receipt = await this.request("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        type: "client-response",
        rpcId,
        result: { ok: true, value },
      }),
    });
    if (!receipt.accepted)
      throw new Error(
        receipt.reason === "not-pending"
          ? "这个请求已处理或已失效，请刷新会话"
          : "回答格式未被 DSH 接受",
      );
    return receipt;
  }
  async balance() {
    return this.request("/dsh-girl/balance.json", { method: "GET" });
  }
  openStream(kind, onOpen = () => {}) {
    // Reserve baseline order before the handshake can race with HTTP reads.
    this.emit("stream-start", { kind });
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${this.endpoint.replace(/^http:/, "ws:")}/api/events.${kind}`,
        {
          headers: this.headers,
          handshakeTimeout: 15000,
          maxPayload: 8 * 1024 * 1024,
          followRedirects: false,
          perMessageDeflate: false,
        },
      );
      const signal = this.controller.signal;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        socket.terminate();
        error ? reject(error) : resolve();
      };
      const abort = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket.on("open", () => {
        onOpen();
        this.streams.add(kind);
        this.emit("stream", { kind, connected: true });
      });
      socket.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type !== "server-request" || !frame.payload?.type)
            throw new Error("无法识别 DSH 事件格式");
          if (frame.payload.type === "stream/error")
            throw new Error("DSH 事件流报告错误");
          this.emit("frame", frame);
        } catch (error) {
          finish(error);
        }
      });
      socket.on("error", (error) =>
        finish(new Error(`DSH ${kind} 事件连接失败：${error.message}`)),
      );
      socket.on("close", () => finish(new Error(`DSH ${kind} 事件连接已断开`)));
    });
  }
  async stream(kind) {
    let delay = 1000;
    while (!this.controller.signal.aborted) {
      try {
        await this.openStream(kind, () => {
          delay = 1000;
        });
        throw new Error("DSH 事件流已断开");
      } catch (error) {
        this.streams.delete(kind);
        if (this.controller.signal.aborted) return;
        this.emit("stream", { kind, connected: false, message: error.message });
        await new Promise((resolve) => {
          const signal = this.controller.signal;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          signal.addEventListener("abort", done, { once: true });
        });
        delay = Math.min(delay * 2, 15000);
      }
    }
  }
  close() {
    this.controller.abort();
    this.removeAllListeners();
  }
}
