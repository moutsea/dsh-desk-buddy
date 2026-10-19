import { _electron as electron, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(
  process.env.DSG_PLUGIN_PACKAGE ||
    `release/${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tgz`,
);
const home = await mkdtemp(join(tmpdir(), "dsg-plugin-install-"));
const env = {
  ...process.env,
  DSH_HOME: home,
  DSG_TEST_UI_DIR: join(home, "browser"),
};
for (const key of Object.keys(env))
  if (
    /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) ||
    /^(DEEPSEEK_GIRL_|DSH_GIRL_|ELECTRON_RUN_AS_NODE)/.test(key)
  )
    delete env[key];
let host, browser, base, desktopPid;
let log = "";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const status = async () => {
  const response = await fetch(base + "/dsh-girl/status.json");
  if (!response.ok) throw new Error(`DSG status HTTP ${response.status}`);
  return response.json();
};
const control = async (action, value) => {
  const response = await fetch(base + "/dsh-girl/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  return body;
};
async function boot() {
  base = undefined;
  log = "";
  host = spawn(
    "dsh",
    ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (part) => {
    log = (log + part).slice(-30000);
  };
  host.stdout.on("data", collect);
  host.stderr.on("data", collect);
  await expect
    .poll(
      () => {
        if (host.exitCode !== null) throw new Error("DSH failed: " + log);
        base = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        return !!base;
      },
      { timeout: 30000 },
    )
    .toBe(true);
}
async function stopHost(signal = "SIGTERM") {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const process = host;
  process.kill(signal);
  await expect
    .poll(() => process.exitCode !== null || process.signalCode !== null, {
      timeout: 15000,
    })
    .toBe(true);
  host = null;
}
try {
  await exec("dsh", ["plugin", "--profile", "web", "add", archive], {
    env,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  const manifestPath = join(home, "profiles/web/package.json");
  let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(
    manifest.dsh.profile.bundles.includes(pkg.name),
    "standard plugin install activates the bundle",
  );
  console.log(
    "Installed complete DSG package through the real DSH plugin CLI.",
  );
  await boot();
  await expect
    .poll(async () => (await status()).phase, { timeout: 90000 })
    .toMatch(/^(running|error)$/);
  assert.equal((await status()).phase, "running", (await status()).error);
  await expect
    .poll(async () => (await status()).connection, { timeout: 30000 })
    .toBe("connected");
  const running = await status();
  desktopPid = running.pid;
  assert.equal(running.endpoint, base);
  assert.equal(running.version, pkg.version);
  assert.equal(running.autoStart, true);
  assert.equal(alive(desktopPid), true);
  const duplicate = await Promise.all([control("start"), control("start")]);
  assert.equal(duplicate[0].pid, desktopPid);
  assert.equal(duplicate[1].pid, desktopPid);
  browser = await electron.launch({
    args: [resolve("tests/helpers/manager-shell.mjs"), base],
    env,
  });
  const page = await browser.firstWindow();
  await page
    .getByRole("button", { name: "dsh-desk-buddy", exact: true })
    .click();
  const panel = page.frameLocator('iframe[title="dsh-desk-buddy 桌宠管理"]');
  await panel.getByText("桌宠已启动", { exact: true }).waitFor();
  await panel.getByText("已连接当前 DSH", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "暂时隐藏", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(false);
  await panel.getByRole("button", { name: "显示桌宠", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(true);
  await panel.getByRole("button", { name: "打开对话", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(true);
  await mkdir("artifacts", { recursive: true });
  await panel
    .locator("body")
    .screenshot({ path: "artifacts/plugin-management.png" });
  await panel.getByRole("switch", { name: "随 DSH 启动" }).uncheck();
  await expect.poll(async () => (await status()).autoStart).toBe(false);
  await panel.getByRole("button", { name: "关闭桌宠", exact: true }).click();
  await panel.getByText("桌宠正在休息", { exact: true }).waitFor();
  assert.equal(alive(desktopPid), false);
  const response = await fetch(base + "/api/host.describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "dsg-plugin-check",
      method: "host.describe",
      payload: {},
    }),
  });
  assert.equal(
    (await response.json()).result.ok,
    true,
    "closing DSG leaves the DSH host running",
  );
  await browser.close();
  browser = null;
  await control("start");
  desktopPid = (await status()).pid;
  await stopHost();
  await expect.poll(() => alive(desktopPid), { timeout: 15000 }).toBe(false);
  await boot();
  await expect.poll(async () => (await status()).phase).toBe("stopped");
  assert.equal(
    (await status()).autoStart,
    false,
    "automatic-start choice survives host restart and port change",
  );
  await control("start");
  await expect
    .poll(async () => (await status()).connection, { timeout: 30000 })
    .toBe("connected");
  desktopPid = (await status()).pid;
  await stopHost("SIGKILL");
  await expect.poll(() => alive(desktopPid), { timeout: 15000 }).toBe(false);
  await exec("dsh", ["plugin", "--profile", "web", "remove", pkg.name], {
    env,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(!manifest.dsh.profile.bundles.includes(pkg.name));
  await boot();
  assert.equal((await fetch(base + "/dsh-girl/status.json")).status, 404);
  assert.ok(
    !(await fetch(base).then((response) => response.text())).includes(
      "/dsh-girl/launcher.js",
    ),
  );
  await writeFile(
    "artifacts/plugin-install-result.json",
    JSON.stringify(
      {
        version: pkg.version,
        realDshInstall: true,
        autoConnection: true,
        managerUI: true,
        controls: true,
        persistentAutoStart: true,
        gracefulHostExit: true,
        hostCrashCleanup: true,
        uninstall: true,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "Plugin integration passed: real DSH tarball install/uninstall, bundled native runtime, automatic current-host connection, discoverable manager, start/show/hide/chat/stop, duplicate prevention, auto-start persistence, host shutdown and crash cleanup. No model calls.",
  );
} catch (error) {
  console.error(log.slice(-9000));
  throw error;
} finally {
  await browser?.close();
  await stopHost();
  if (desktopPid)
    await expect.poll(() => alive(desktopPid), { timeout: 15000 }).toBe(false);
  await rm(home, { recursive: true, force: true });
}
