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
import { x as extractTar, c as createTar } from "tar";

const executablePath =
  process.env.DSG_DESKTOP_EXECUTABLE ||
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(
  process.env.DSG_PLUGIN_PACKAGE ||
    `release/${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tgz`,
);
let installSpec = process.env.DSG_PLUGIN_SPEC || archive;
const bundleName = process.env.DSG_PLUGIN_NAME || pkg.name;
const home = await mkdtemp(join(tmpdir(), "dsg-desktop-install-"));
const testUpdate = process.env.DSG_TEST_MANUAL_UPDATE === "1";
const testRollback = testUpdate && process.env.DSG_TEST_UPDATE_ROLLBACK === "1";
const testRemovalRestart =
  testUpdate && process.env.DSG_TEST_UPDATE_RESTART === "1";
const testRemovalFailure =
  testUpdate && process.env.DSG_TEST_UPDATE_REMOVE_FAILURE === "1";
const testRecovery = testRollback || testRemovalFailure;
if (testUpdate) {
  const seed = join(home, "seed");
  await mkdir(seed);
  await extractTar({ file: archive, cwd: seed });
  const manifest = join(seed, "package/package.json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  metadata.version = "0.0.0";
  await writeFile(manifest, JSON.stringify(metadata));
  // This isolated seed only fakes version metadata to exercise an update.
  // Keep the plugin/runtime manifests consistent with the installer guard.
  const runtimePath = join(seed, "package/runtime.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  runtime.version = metadata.version;
  await writeFile(runtimePath, JSON.stringify(runtime));
  if (testRecovery || testRemovalRestart) {
    const entry = join(seed, "package/index.mjs");
    const code = await readFile(entry, "utf8");
    const original = 'service: () => ctx.get?.("pluginManager"),';
    assert.ok(code.includes(original));
    await writeFile(
      entry,
      code.replace(
        original,
        `service: () => {
      const service = ctx.get("pluginManager");
      return {
        listBundles: () => service.listBundles(),
        setBundleEnabled: (...args) => service.setBundleEnabled(...args),
        removeBundle: async name => {
          if (${testRemovalFailure}) {
            // Real DSH unloads the bundle before pnpm runs. Reproduce a pnpm
            // failure after that unload while the original files remain.
            const disabled = await service.setBundleEnabled(name, false);
            if (disabled.error) return disabled;
            return { application: "failed", error: { code: "operation-error" },
              packageResult: { output: "[ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY] test fixture" } };
          }
          const result = await service.removeBundle(name);
          return ${testRemovalRestart} && result.application === "applied" && !result.error
            ? { ...result, application: "restart-required", restartReason: "pending-entry" }
            : result;
        },
        installBundle: (archive, options) => !${testRollback} || archive.includes("rollback-")
          ? service.installBundle(archive, options)
          : Promise.resolve({ application: "failed", error: { code: "incompatible-version" } })
      };
    },`,
      ),
    );
  }
  installSpec = join(home, "update-seed.tgz");
  await createTar({ file: installSpec, cwd: seed, gzip: true }, ["package"]);
}
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
let app, page, pid, updateResult;
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
  await page
    .getByRole("button", { name: "dsh-desk-buddy", exact: true })
    .click();
  const frame = page.frameLocator('iframe[title="dsh-desk-buddy 桌宠管理"]');
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
        return manifest.dsh.profile.bundles.includes(bundleName);
      },
      {
        timeout: 180000,
        message: "Official plugin installer activates DSG bundle",
      },
    )
    .toBe(true);
  console.log("Official Desktop plugin UI installed the plugin:", installSpec);
  // Host restart reloads the shell's startup injection snapshot as in normal use.
  await app.close();
  app = null;
  await boot();
  await expect
    .poll(async () => (await status()).connection, { timeout: 360000 })
    .toBe("connected");
  const running = await status();
  pid = running.pid;
  assert.equal(running.hostKind, "desktop");
  assert.equal(running.version, testUpdate ? "0.0.0" : pkg.version);
  assert.equal(running.error, "");
  assert.ok(alive(pid));
  assert.ok(!JSON.stringify(running).includes("token"));
  const frame = await manager();
  assert.equal(
    running.update.currentVersion,
    testUpdate ? "0.0.0" : pkg.version,
  );
  assert.equal(running.update.unavailable, "");
  await expect(
    frame.getByRole("button", { name: "检查更新", exact: true }),
  ).toBeEnabled();
  assert.equal(
    await frame
      .locator(".brand img")
      .evaluate((node) => node.complete && node.naturalWidth),
    128,
  );
  await page
    .getByRole("button", { name: "dsh-desk-buddy", exact: true })
    .click();
  await page.getByText("插件", { exact: true }).first().click();
  const expectedLogo =
    "data:image/png;base64," +
    (await readFile("plugins/dsh-girl/web/icon.png")).toString("base64");
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll(
          (nodes, src) => nodes.some((node) => node.src === src),
          expectedLogo,
        ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "dsh-desk-buddy", exact: true })
    .click();
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
  await frame.getByRole("button", { name: "关闭桌宠", exact: true }).click();
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
  await frame.getByRole("button", { name: "启动桌宠", exact: true }).click();
  await expect
    .poll(async () => (await status()).connection, { timeout: 45000 })
    .toBe("connected");
  const restarted = await status();
  pid = restarted.pid;
  assert.equal(restarted.error, "");
  await frame.locator("#auto-start").check();
  await expect.poll(async () => (await status()).autoStart).toBe(true);
  await page.screenshot({ path: "artifacts/desktop-management.png" });
  if (testUpdate) {
    await frame.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect
      .poll(async () => (await status()).update.phase, { timeout: 30000 })
      .toBe("available");
    const target = (await status()).update.latestVersion;
    const installResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/dsh-girl/control") &&
        response.request().postDataJSON()?.action === "installUpdate",
    );
    await frame
      .getByRole("button", { name: `下载并更新至 v${target}`, exact: true })
      .click();
    const updateJob = (await (await installResponse).json()).update.jobUrl;
    assert.ok(updateJob);
    await expect
      .poll(
        async () => {
          const update = await page.evaluate(
            async (path) => (await fetch(path)).json(),
            updateJob,
          );
          if (update.phase === "error" && !testRecovery)
            throw new Error(update.error);
          if (update.phase === "error")
            assert.match(update.error, /已恢复旧版/);
          if (update.phase === "error" && testRemovalFailure)
            assert.match(update.error, /依赖锁文件不完整/);
          return update.phase;
        },
        { timeout: 360000 },
      )
      .toBe(testRecovery ? "error" : "restart-required");
    await expect
      .poll(async () => (await status()).connection, { timeout: 90000 })
      .toBe("connected");
    await expect(
      frame.locator(testRecovery ? "#update-error" : "#update-status"),
    ).toContainText("重启 DSH");
    await page.screenshot({
      path: testRemovalFailure
        ? "artifacts/desktop-update-removal-failure.png"
        : testRollback
          ? "artifacts/desktop-update-rollback.png"
          : "artifacts/desktop-manual-update.png",
    });
    await app.close();
    app = null;
    await boot();
    await expect
      .poll(async () => (await status()).connection, { timeout: 90000 })
      .toBe("connected");
    assert.equal((await status()).version, testRecovery ? "0.0.0" : target);
    if (testRecovery)
      assert.equal((await status()).update.currentVersion, "0.0.0");
    assert.equal((await status()).autoStart, true);
    assert.equal(
      JSON.parse(await readFile(storage, "utf8")).selectedId,
      created.sessionId,
    );
    pid = (await status()).pid;
    updateResult = {
      from: "0.0.0 test seed",
      to: testRecovery ? "0.0.0 restored test seed" : target,
      hostCodeAndRuntime: true,
      preferencesAndHistoryRetained: true,
      failureRecovery: testRecovery,
      failedRemovalRecovery: testRemovalFailure,
      removalRequiresRestart: testRemovalRestart,
    };
  }
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
        pluginLogo: true,
        manualUpdate: updateResult,
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
