import { readFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { apply as applyBalance } from "../dsh-girl-bridge/index.mjs";
import { desktopBridge } from "./desktop-bridge.mjs";
import { DesktopManager } from "./manager.mjs";
import { PluginUpdater, backupPlugin } from "./updater.mjs";

export const name = "dsh-desk-buddy";
export const inject = ["webServer", "credentials", "connection"];
const root = dirname(fileURLToPath(import.meta.url));

export function localRequest(req, port) {
  try {
    const authority = new URL("http://" + req.headers.host);
    const remote = req.socket?.remoteAddress;
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname) &&
      Number(authority.port || 80) === port &&
      (!remote || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) &&
      req.headers["sec-fetch-site"] !== "cross-site" &&
      (!req.headers.origin ||
        new URL(req.headers.origin).origin === authority.origin)
    );
  } catch {
    return false;
  }
}
export function usesDesktopProtocol(ctx) {
  const gateway = ctx.get?.("typertGateway");
  return (
    typeof gateway?.wireStream?.open === "function" &&
    typeof ctx.connection?.createPeer === "function"
  );
}
function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
export async function apply(ctx, options = {}) {
  // Desktop publishes the service before binding its random port. Do not block
  // plugin activation: the application binds only after the plugin tree is ready.
  let disposed = false,
    bridge;
  const endpoint = () => `http://127.0.0.1:${ctx.webServer.port}`;
  const profile =
    ctx.get?.("loader")?.config?.baseUrl || process.env.DSH_HOME || "web";
  const storage =
    options.storageRoot ||
    join(
      process.env.DSH_HOME || join(homedir(), ".dsh"),
      "deepseek-girl",
      createHash("sha256").update(profile).digest("hex").slice(0, 16),
    );
  if (!isAbsolute(storage)) throw new Error("桌宠数据目录必须为绝对路径");
  const manager = new DesktopManager({
    endpoint: "",
    storage,
    root,
    autoStart: options.autoStart !== false,
  });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const updater = new PluginUpdater({
    version: pkg.version,
    storage,
    service: () => ctx.get?.("pluginManager"),
    hotReload: () => !!ctx.get?.("hmr"),
    backup: (directory) => backupPlugin(root, directory),
    trackJob: (job) => {
      const webServer = ctx.webServer;
      const path = `/dsh-desk-buddy-update/${randomUUID()}`;
      const unregister = webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => {
          if (req.method !== "GET" || !localRequest(req, webServer.port))
            return json(res, 403, { error: "仅允许从当前 DSH 查看更新" });
          json(res, 200, job.snapshot());
        },
      });
      void job.operation.finally(() => {
        setTimeout(unregister, 15 * 60 * 1000).unref();
      });
      return path;
    },
  });
  const snapshot = () => ({
    ...manager.snapshot(),
    update: updater.snapshot(),
  });
  const assets = new Map(
    await Promise.all(
      [
        ["/dsh-girl/", "index.html", "text/html"],
        ["/dsh-girl/manager.js", "manager.js", "text/javascript"],
        ["/dsh-girl/manager.css", "manager.css", "text/css"],
        ["/dsh-girl/launcher.js", "launcher.js", "text/javascript"],
        ["/dsh-girl/icon.png", "icon.png", "image/png"],
      ].map(async ([url, file, type]) => [
        url,
        { body: await readFile(join(root, "web", file)), type },
      ]),
    ),
  );
  applyBalance(ctx);
  const dispose = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-girl",
    handler: async (req, res) => {
      if (!localRequest(req, ctx.webServer.port))
        return json(res, 403, {
          error: "仅允许从当前电脑的 DSH 页面管理桌宠",
        });
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (path === "/dsh-girl/status.json" && req.method === "GET")
        return json(res, 200, {
          ...snapshot(),
          ...(manager.connection !== "connected" && bridge?.error
            ? { error: bridge.error }
            : {}),
        });
      if (path === "/dsh-girl/control") {
        if (req.method !== "POST")
          return json(res, 405, { error: "请使用管理按钮操作桌宠" });
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
        )
          return json(res, 415, { error: "请求格式无效" });
        try {
          const chunks = [];
          let length = 0;
          for await (const part of req) {
            length += part.length;
            if (length > 4096) return json(res, 413, { error: "请求过大" });
            chunks.push(part);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!manager.endpoint) throw new Error("DSH 正在启动，请稍后再试");
          if (body.action === "checkUpdate") updater.check();
          else if (body.action === "installUpdate") updater.install(body.value);
          else await manager.control(body.action, body.value);
          return json(res, 200, snapshot());
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }
      const asset = assets.get(path === "/dsh-girl" ? "/dsh-girl/" : path);
      if (req.method !== "GET" || !asset)
        return json(res, 404, { error: "未找到桌宠页面" });
      res.writeHead(200, {
        "Content-Type": asset.type + "; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      });
      res.end(asset.body);
    },
  });
  ctx.effect(() => dispose);
  if (typeof ctx.webServer.collectIndexInjections === "function") {
    ctx.on("webserver/index-inject", (table) =>
      table.push({
        kind: "script-src",
        placement: "body",
        src: "/dsh-girl/launcher.js",
      }),
    );
  } else {
    const untap = ctx.webServer.tapIndex((html) =>
      html.replace(
        /<\/body>/i,
        '<script type="module" src="/dsh-girl/launcher.js"></script></body>',
      ),
    );
    ctx.effect(() => untap);
  }
  ctx.effect(() => async () => {
    disposed = true;
    await updater.dispose();
    await manager.dispose();
    await bridge?.dispose();
  });
  queueMicrotask(async () => {
    try {
      const deadline = Date.now() + 30000;
      while (
        !disposed &&
        (!Number.isInteger(ctx.webServer.port) || ctx.webServer.port < 1)
      ) {
        if (disposed) return;
        if (Date.now() > deadline) throw new Error("DSH 本机服务启动超时");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (disposed) return;
      const modern = usesDesktopProtocol(ctx);
      if (modern) bridge = await desktopBridge(ctx);
      if (disposed) {
        await bridge?.dispose();
        return;
      }
      manager.endpoint = bridge?.endpoint || endpoint();
      manager.displayEndpoint = endpoint();
      manager.token = bridge?.token;
      manager.hostKind = modern ? "desktop" : "web";
      await manager.init();
    } catch (error) {
      if (disposed) return;
      manager.phase = "error";
      manager.error = error.message;
      ctx.logger?.warn?.("桌宠：%s", error.message);
    }
  });
}
export default { name, inject, apply };
