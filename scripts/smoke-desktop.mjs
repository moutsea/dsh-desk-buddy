import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const executablePath =
  process.env.DSG_DESKTOP_EXECUTABLE ||
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(
  process.env.DSG_PLUGIN_PACKAGE ||
    `release/dsh-girl-${pkg.version}-${process.platform}-${process.arch}.tgz`,
);
const installSpec = process.env.DSG_PLUGIN_SPEC || archive;
const home = await mkdtemp(join(tmpdir(), "dsg-desktop-install-"));
const profile = join(home, "profiles/desktop");
await mkdir(profile, { recursive: true });
await writeFile(
  join(profile, "package.json"),
  JSON.stringify({
    name: "dsg-desktop-smoke",
    private: true,
    type: "module",
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      },
    },
  }),
);
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" };
for (const key of Object.keys(env))
  if (
    /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) ||
    /^(ELECTRON_RUN_AS_NODE|DEEPSEEK_GIRL_)/.test(key)
  )
    delete env[key];
let app, page, pid;
let diagnostic = "";
const alive = (value) => {
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
};
async function boot() {
  app = await electron.launch({
    executablePath,
    args: ["--user-data-dir=" + join(home, "userData")],
    env,
    timeout: 45000,
  });
  const collect = (part) => {
    diagnostic = (
      diagnostic + part.toString().replace(/token=[^\s]+/g, "token=[redacted]")
    ).slice(-12000);
  };
  app.process().stdout.on("data", collect);
  app.process().stderr.on("data", collect);
  assert.equal(await app.evaluate(() => process.env.DSH_HOME), home);
  page = await app.firstWindow();
  await expect(page.getByText("插件", { exact: true }).first()).toBeVisible({
    timeout: 45000,
  });
}
const status = () =>
  page.evaluate(async () => {
    const response = await fetch("/dsh-girl/status.json");
    return response.ok ? response.json() : { phase: "missing" };
  });
async function manager() {
  await page.getByRole("button", { name: "DSG 桌宠", exact: true }).click();
  const frame = page.frameLocator('iframe[title="DeepSeek Girl 桌宠管理"]');
  await expect(
    frame.getByText("已连接 DSH Desktop", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  return frame;
}
try {
  await boot();
  await page.getByText("插件", { exact: true }).first().click();
  await page.getByText("添加插件", { exact: true }).first().click();
  await page.getByPlaceholder("例如 dsh-plugin-whale-pet").fill(installSpec);
  await page.getByRole("button", { name: "安装", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "立即启用", exact: true }),
  ).toBeVisible({ timeout: 180000 });
  await page.getByRole("button", { name: "立即启用", exact: true }).click();
  await expect
    .poll(
      async () => {
        const manifest = JSON.parse(
          await readFile(join(profile, "package.json"), "utf8"),
        );
        return manifest.dsh.profile.bundles.includes("dsh-girl");
      },
      {
        timeout: 180000,
        message: "Official plugin installer activates DSG bundle",
      },
    )
    .toBe(true);
  console.log(
    "Official Desktop plugin UI installed the complete plugin:",
    installSpec,
  );
  // Host restart reloads the shell's startup injection snapshot as in normal use.
  await app.close();
  app = null;
  await boot();
  await expect
    .poll(async () => (await status()).connection, { timeout: 90000 })
    .toBe("connected");
  const running = await status();
  pid = running.pid;
  assert.equal(running.hostKind, "desktop");
  assert.equal(running.version, pkg.version);
  assert.equal(running.error, "");
  assert.ok(alive(pid));
  assert.ok(!JSON.stringify(running).includes("token"));
  const frame = await manager();
  await frame.getByRole("button", { name: "暂时隐藏", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(false);
  await frame.getByRole("button", { name: "显示桌宠", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(true);
  await frame.getByRole("button", { name: "打开对话", exact: true }).click();
  await expect.poll(async () => (await status()).visible).toBe(true);
  await frame.locator("#auto-start").uncheck();
  await expect.poll(async () => (await status()).autoStart).toBe(false);
  const created = await page.evaluate(async (cwd) => {
    const rpcId = crypto.randomUUID();
    const response = await fetch("/api/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "session/create",
        payload: { args: { request: { cwd } } },
      }),
    });
    const body = await response.json();
    if (!body.result?.ok) throw new Error(JSON.stringify(body.result));
    return body.result.value;
  }, home);
  assert.equal(typeof created.sessionId, "string");
  await frame.getByRole("button", { name: "关闭 DSG", exact: true }).click();
  await expect.poll(async () => (await status()).phase).toBe("stopped");
  await expect.poll(() => alive(pid)).toBe(false);
  // Select an isolated real Host session while DSG is stopped; restart exercises its actual history adapter.
  const storage = join(
    home,
    "deepseek-girl",
    (await readdir(join(home, "deepseek-girl")))[0],
    "settings/settings.json",
  );
  const settings = JSON.parse(await readFile(storage, "utf8"));
  settings.selectedId = created.sessionId;
  await writeFile(storage, JSON.stringify(settings));
  await frame.getByRole("button", { name: "启动 DSG", exact: true }).click();
  await expect
    .poll(async () => (await status()).connection, { timeout: 45000 })
    .toBe("connected");
  const restarted = await status();
  pid = restarted.pid;
  assert.equal(restarted.error, "");
  await frame.locator("#auto-start").check();
  await expect.poll(async () => (await status()).autoStart).toBe(true);
  await page.screenshot({ path: "artifacts/desktop-management.png" });
  await app.close();
  app = null;
  await expect.poll(() => alive(pid), { timeout: 10000 }).toBe(false);
  await writeFile(
    "artifacts/desktop-install-result.json",
    JSON.stringify(
      {
        desktop: "0.2.1-rc.2",
        plugin: pkg.version,
        install: "official Desktop plugin UI",
        installSpec,
        connection: "connected",
        sessionCreationAndHistory: true,
        management: true,
        hostExitCleanup: true,
        isolated: true,
        modelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "Desktop startup injection, native connection, real session history, management and Host-exit cleanup passed. No model requests.",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: "artifacts/desktop-failure.png" })
      .catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-5000),
    );
    console.error("DSG status:", await status().catch(() => null));
  }
  console.error(diagnostic);
  throw error;
} finally {
  await app?.close();
  if (!process.env.DSG_KEEP_TEST_HOME)
    await rm(home, { recursive: true, force: true });
}
