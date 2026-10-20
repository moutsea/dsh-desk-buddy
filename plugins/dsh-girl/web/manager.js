const labels = {
  stopped: "桌宠正在休息",
  installing: "正在准备桌宠组件…",
  starting: "正在唤醒桌宠…",
  running: "桌宠已启动",
  stopping: "正在关闭桌宠…",
  error: "桌宠暂时没有启动",
};
let busy = false;
let current = null;
let revision = 0;
function render(state) {
  current = state;
  const replacing = ["installing", "restoring"].includes(state.update?.phase);
  document.querySelector("#phase").textContent =
    labels[state.phase] || "正在读取状态…";
  document.querySelector("#status-dot").className = "dot " + state.phase;
  document.querySelector("#version").textContent = state.version
    ? "v" + state.version
    : "";
  document.querySelector("#connection").textContent =
    state.phase === "running"
      ? state.connection === "connected"
        ? state.hostKind === "desktop"
          ? "已连接 DSH Desktop"
          : "已连接当前 DSH"
        : "正在连接当前 DSH…"
      : "自动连接当前 DSH";
  document.querySelector("#auto-start").checked = state.autoStart;
  document.querySelector("#auto-start").disabled = busy || replacing;
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.disabled =
      busy ||
      replacing ||
      ["installing", "starting", "stopping"].includes(state.phase) ||
      (action === "start"
        ? state.phase === "running"
        : state.phase !== "running");
  }
  const error = document.querySelector("#error");
  error.textContent = state.error || "";
  error.hidden = !state.error;
  renderUpdate(state.update);
}
function renderUpdate(update) {
  const pending = [
    "checking",
    "downloading",
    "installing",
    "restoring",
  ].includes(update?.phase);
  const restart = update?.phase === "restart-required";
  document.querySelector("#plugin-version").textContent = update?.currentVersion
    ? "v" + update.currentVersion
    : "";
  const labels = {
    idle: "手动检查 GitHub 上的最新正式版",
    checking: "正在检查新版本…",
    current: "当前已是最新版本",
    available: `发现新版本 v${update?.latestVersion}`,
    downloading: `正在下载更新包… ${Math.floor((update?.downloaded || 0) / 1024 / 1024)} MB`,
    installing: "下载校验完成，正在更新插件，请保持 DSH 打开…",
    restoring: "更新未完成，正在恢复旧版插件…",
    "restart-required": `v${update?.latestVersion} 已安装，请在任务完成后重启 DSH`,
    error: "更新未完成，可以重试",
  };
  document.querySelector("#update-status").textContent =
    update?.unavailable || labels[update?.phase] || "暂时无法读取更新状态";
  const check = document.querySelector('[data-update="checkUpdate"]');
  const install = document.querySelector('[data-update="installUpdate"]');
  check.disabled =
    busy || !update || !!update.unavailable || pending || restart;
  install.hidden = !update?.latestVersion || restart;
  install.disabled = busy || pending || !!update?.unavailable;
  install.textContent = `下载并更新至 v${update?.latestVersion || ""}`;
  const progress = document.querySelector("#update-progress");
  progress.hidden = update?.phase !== "downloading";
  progress.max = update?.size || 1;
  progress.value = update?.downloaded || 0;
  const error = document.querySelector("#update-error");
  error.textContent = update?.error || "";
  error.hidden = !update?.error;
  const link = document.querySelector("#release-link");
  link.hidden = !update?.releaseUrl;
  if (update?.releaseUrl) link.href = update.releaseUrl;
}
async function request(action, value) {
  if (busy) return;
  const previous = current;
  revision++;
  busy = true;
  if (current)
    render(action === "autoStart" ? { ...current, autoStart: value } : current);
  try {
    const response = await fetch("/dsh-girl/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "暂时无法操作桌宠");
    render(body);
  } catch (error) {
    if (previous) render({ ...previous, error: error.message });
  } finally {
    busy = false;
    if (current) render(current);
  }
}
document
  .querySelectorAll("[data-action]")
  .forEach((button) =>
    button.addEventListener("click", () => request(button.dataset.action)),
  );
document
  .querySelectorAll("[data-update]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      request(button.dataset.update, current?.update?.latestVersion),
    ),
  );
document
  .querySelector("#auto-start")
  .addEventListener("change", (event) =>
    request("autoStart", event.target.checked),
  );
async function refresh() {
  if (busy || document.hidden) return;
  const expectedRevision = revision;
  try {
    const jobUrl = current?.update?.jobUrl;
    const response = await fetch(jobUrl || "/dsh-girl/status.json");
    if (jobUrl && response.status === 404) {
      current.update.jobUrl = "";
      return;
    }
    if (!response.ok) throw new Error("暂时无法读取桌宠状态");
    const body = await response.json();
    let state = body;
    if (jobUrl) {
      let latest = current;
      try {
        const status = await fetch("/dsh-girl/status.json");
        if (status.ok) latest = await status.json();
      } catch {}
      state = { ...latest, update: body };
    }
    if (!busy && revision === expectedRevision) render(state);
  } catch {
    document.querySelector("#phase").textContent = "DSH 连接已断开";
    document
      .querySelectorAll("button, input")
      .forEach((node) => (node.disabled = true));
  }
}
document.addEventListener("visibilitychange", refresh);
setInterval(refresh, 1200);
void refresh();
