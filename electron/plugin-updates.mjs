import { normalizeEndpoint } from "../shared/dsh-client.mjs";

export class PluginUpdates {
  constructor(endpoint, version) {
    this.endpoint = endpoint ? normalizeEndpoint(endpoint) : null;
    this.version = version;
    this.jobUrl = "";
  }
  async request(action, version) {
    if (!this.endpoint)
      return {
        phase: "idle",
        currentVersion: this.version,
        unavailable: "请通过 DSH 插件启动桌宠，再在这里管理插件更新。",
      };
    if (action && !["checkUpdate", "installUpdate"].includes(action))
      throw new Error("未知更新操作");
    if (action === "installUpdate" && typeof version !== "string")
      throw new Error("请先检查新版本");
    const path = action
      ? "/dsh-girl/control"
      : this.jobUrl || "/dsh-girl/status.json";
    let response;
    try {
      response = await fetch(this.endpoint + path, {
        method: action ? "POST" : "GET",
        ...(action
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, value: version }),
            }
          : {}),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error("无法连接 DSH 插件管理服务，请确认 DSH 仍在运行后重试。");
    }
    if (!action && this.jobUrl && response.status === 404) {
      this.jobUrl = "";
      return this.request();
    }
    if (!response.ok)
      throw new Error("无法读取插件更新状态，请确认 DSH 插件已启用后重试。");
    const body = await response.json();
    const update = body.update || body;
    if (typeof update.phase !== "string" || !update.currentVersion)
      throw new Error("当前 DSH 插件未提供更新功能，请先升级插件。");
    this.jobUrl = /^\/dsh-desk-buddy-update\/[a-f0-9-]{36}$/.test(update.jobUrl)
      ? update.jobUrl
      : "";
    return update;
  }
}
