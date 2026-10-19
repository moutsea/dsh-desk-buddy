import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { prepareRuntime } from "./runtime.mjs";

export function desktopEnvironment(endpoint, data, env = process.env) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) &&
        !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DEEPSEEK_GIRL_|DSH_GIRL_)/i.test(
          key,
        ),
    ),
  );
  return {
    ...clean,
    DEEPSEEK_GIRL_MANAGED: "1",
    DEEPSEEK_GIRL_ENDPOINT: endpoint,
    DEEPSEEK_GIRL_DATA_DIR: data,
  };
}
export class DesktopManager {
  constructor({
    endpoint,
    displayEndpoint = endpoint,
    token,
    hostKind = "web",
    storage,
    root,
    autoStart = true,
    runtime = prepareRuntime,
  }) {
    this.endpoint = endpoint;
    this.displayEndpoint = displayEndpoint;
    this.token = token;
    this.hostKind = hostKind;
    this.storage = storage;
    this.root = root;
    this.runtime = runtime;
    this.autoStart = autoStart;
    this.phase = "stopped";
    this.error = "";
    this.connection = "offline";
    this.visible = false;
    this.disposed = false;
    this.queue = Promise.resolve();
    this.child = null;
  }
  async init() {
    try {
      const saved = JSON.parse(
        await readFile(join(this.storage, "preferences.json"), "utf8"),
      );
      if (typeof saved.autoStart === "boolean")
        this.autoStart = saved.autoStart;
    } catch {}
    if (this.autoStart && !this.disposed) return this.start();
    return this.snapshot();
  }
  snapshot() {
    return {
      phase: this.phase,
      error: this.error,
      endpoint: this.displayEndpoint,
      hostKind: this.hostKind,
      autoStart: this.autoStart,
      connection: this.connection,
      visible: this.visible,
      version: this.version || "",
      pid: this.child?.pid || null,
    };
  }
  exclusive(run) {
    const result = this.queue.catch(() => {}).then(run);
    this.queue = result;
    return result;
  }
  start() {
    return this.exclusive(async () => {
      if (this.disposed) throw new Error("DSG 插件已停用");
      if (this.child) return this.snapshot();
      this.phase = "installing";
      this.error = "";
      try {
        const runtime = await this.runtime(
          this.root,
          join(this.storage, "runtime"),
        );
        if (this.disposed) throw new Error("DSG 插件已停用");
        this.version = runtime.version;
        this.phase = "starting";
        const child = spawn(runtime.executable, runtime.args || [], {
          env: {
            ...desktopEnvironment(
              this.endpoint,
              join(this.storage, "settings"),
            ),
            ...(this.token
              ? { DEEPSEEK_GIRL_CONNECTION_TOKEN: this.token }
              : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        this.child = child;
        child.stdin.on("error", () => {});
        child.stderr.on("data", () => {}); // Never forward inherited diagnostics/credentials to the browser.
        const lines = createInterface({ input: child.stdout });
        let ready, fail;
        const started = new Promise((resolve, reject) => {
          ready = resolve;
          fail = reject;
        });
        const timeout = setTimeout(
          () =>
            fail(new Error("DSG 启动超时，请重试或检查系统是否允许打开桌宠")),
          20000,
        );
        lines.on("line", (line) => {
          if (!line.startsWith("DSG_CONTROL ")) return;
          try {
            const message = JSON.parse(line.slice(12));
            if (message.type === "ready") {
              this.phase = "running";
              ready();
            }
            if (message.type === "status") {
              this.visible = !!message.visible;
              this.connection = message.connection;
            }
          } catch {}
        });
        child.on("error", () =>
          fail(new Error("无法启动 DSG 桌宠组件，请检查安装是否完整")),
        );
        child.on("exit", () => {
          lines.close();
          if (this.child === child) {
            this.child = null;
            this.visible = false;
            this.connection = "offline";
            if (this.phase !== "error") this.phase = "stopped";
          }
          fail(new Error("DSG 在启动完成前退出，可能已有同一插件实例正在运行"));
        });
        try {
          await started;
        } finally {
          clearTimeout(timeout);
        }
        return this.snapshot();
      } catch (error) {
        await this.stopChild();
        this.phase = "error";
        this.error = error.message;
        throw error;
      }
    });
  }
  send(action) {
    if (!this.child || this.phase !== "running")
      throw new Error("请先启动 DSG");
    this.child.stdin.write(JSON.stringify({ action }) + "\n");
  }
  async stopChild() {
    const child = this.child;
    if (!child) return;
    if (!child.pid) {
      this.child = null;
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.write('{"action":"stop"}\n');
    const terminate = setTimeout(() => child.kill("SIGTERM"), 5000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 7000);
    try {
      await exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
  stop() {
    return this.exclusive(async () => {
      this.phase = "stopping";
      await this.stopChild();
      this.phase = "stopped";
      this.error = "";
      return this.snapshot();
    });
  }
  async control(action, value) {
    if (this.disposed) throw new Error("DSG 插件已停用");
    if (action === "start") return this.start();
    if (action === "stop") return this.stop();
    if (["show", "hide", "chat"].includes(action)) {
      await this.start();
      this.send(action);
      return this.snapshot();
    }
    if (action === "autoStart")
      return this.exclusive(async () => {
        if (typeof value !== "boolean") throw new Error("无效的自动启动设置");
        await mkdir(this.storage, { recursive: true });
        const file = join(this.storage, "preferences.json");
        await writeFile(file + ".tmp", JSON.stringify({ autoStart: value }));
        await rename(file + ".tmp", file);
        this.autoStart = value;
        return this.snapshot();
      });
    throw new Error("未知的 DSG 管理操作");
  }
  dispose() {
    this.disposed = true;
    return this.stop();
  }
}
