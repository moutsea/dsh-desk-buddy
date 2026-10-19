const labels = {
  stopped: "DSG 正在休息",
  installing: "正在准备桌宠组件…",
  starting: "正在唤醒 DSG…",
  running: "DSG 已启动",
  stopping: "正在关闭 DSG…",
  error: "DSG 暂时没有启动",
};
let busy = false;
let current = null;
let revision = 0;
function render(state) {
  current = state;
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
  document.querySelector("#auto-start").disabled = busy;
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.disabled =
      busy ||
      ["installing", "starting", "stopping"].includes(state.phase) ||
      (action === "start"
        ? state.phase === "running"
        : state.phase !== "running");
  }
  const error = document.querySelector("#error");
  error.textContent = state.error || "";
  error.hidden = !state.error;
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
    if (!response.ok) throw new Error(body.error || "暂时无法操作 DSG");
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
  .querySelector("#auto-start")
  .addEventListener("change", (event) =>
    request("autoStart", event.target.checked),
  );
async function refresh() {
  if (busy || document.hidden) return;
  const expectedRevision = revision;
  try {
    const response = await fetch("/dsh-girl/status.json");
    if (!response.ok) throw new Error("暂时无法读取 DSG 状态");
    const state = await response.json();
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
