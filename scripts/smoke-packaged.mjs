import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import { DesktopManager } from "../plugins/dsh-girl/manager.mjs";
import { prepareRuntime } from "../plugins/dsh-girl/runtime.mjs";
import { createFixture } from "../tests/fixture.mjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(
  process.env.DSG_PLUGIN_PACKAGE ||
    `release/${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tgz`,
);
const directory = await mkdtemp(join(tmpdir(), "DSG packaged 中文 "));
const fixture = await createFixture();
const storage = join(directory, "profile");
const root = join(directory, "node_modules", pkg.name);
let manager;

async function run(script, executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, DSG_TEST_EXECUTABLE: executable },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${script} failed (${code ?? signal})`)),
    );
  });
}

try {
  if (!process.env.npm_execpath)
    throw new Error("请通过 npm run test:packaged 运行");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "dsg-package-smoke", private: true }),
  );
  await promisify(execFile)(
    process.execPath,
    [
      process.env.npm_execpath,
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      archive,
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const installed = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(installed.version, pkg.version);
  assert.deepEqual(installed.os, [process.platform]);
  assert.deepEqual(installed.cpu, [process.arch]);
  assert.equal(installed.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(installed.icon, "./web/icon.png");
  assert.equal(installed.exports["./package.json"], "./package.json");
  assert.ok((await readFile(join(root, installed.icon))).length < 256 * 1024);
  const plugin = await import(pathToFileURL(join(root, "index.mjs")).href);
  assert.equal(plugin.name, pkg.name);
  assert.equal(typeof plugin.apply, "function");
  await mkdir(join(storage, "settings"), { recursive: true });
  await writeFile(
    join(storage, "settings/settings.json"),
    JSON.stringify({ alwaysOnTop: false }),
  );
  manager = new DesktopManager({ endpoint: fixture.endpoint, storage, root });
  await manager.init();
  console.log("Managed startup:", manager.snapshot());
  manager.child?.stderr.on("data", (part) => console.error(part.toString()));
  manager.child?.on("exit", (code, signal) =>
    console.log("Managed exit:", { code, signal }),
  );
  await expect
    .poll(() => manager.connection, { timeout: 45000 })
    .toBe("connected");
  await expect.poll(() => manager.visible).toBe(true);
  assert.equal(manager.version, pkg.version);
  const firstPid = manager.child.pid;
  await manager.start();
  assert.equal(manager.child.pid, firstPid);
  await manager.control("hide");
  await expect.poll(() => manager.visible).toBe(false);
  await manager.control("show");
  await expect.poll(() => manager.visible).toBe(true);
  await manager.control("chat");
  await manager.stop();
  assert.equal(manager.child, null);
  await manager.start();
  await expect
    .poll(() => manager.connection, { timeout: 45000 })
    .toBe("connected");
  manager.controlStream.end();
  await expect.poll(() => manager.child, { timeout: 15000 }).toBe(null);
  await manager.dispose();
  const saved = JSON.parse(
    await readFile(join(storage, "settings/settings.json"), "utf8"),
  );
  assert.equal(saved.endpoint, fixture.endpoint);
  const runtime = await prepareRuntime(root, join(storage, "runtime"));
  console.log(
    "Installed tarball, verified native runtime, private-pipe control, restart and parent-disconnect cleanup.",
  );
  const failures = [];
  for (const name of [
    "settings-update",
    "expand",
    "ui",
    "size",
    "drag",
    "stream",
    "usage",
    "completion",
    "sound",
    "progress",
    "motion",
    "window",
  ]) {
    try {
      await run(`scripts/smoke-${name}.mjs`, runtime.executable);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Packaged desktop checks failed");
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/packaged-result.json",
    JSON.stringify(
      {
        version: pkg.version,
        platform: process.platform,
        arch: process.arch,
        installedTarball: true,
        nativeRuntime: true,
        privatePipeControl: true,
        parentDisconnectCleanup: true,
        desktopInteractions: [
          "settings-update",
          "expand",
          "ui",
          "size",
          "drag",
          "stream",
          "usage",
          "completion",
          "sound",
          "progress",
          "motion",
          "window",
        ],
        host: "isolated protocol fixture; no model requests",
      },
      null,
      2,
    ),
  );
  console.log(
    `Packaged ${process.platform}/${process.arch} desktop validation passed.`,
  );
} catch (error) {
  console.error(
    "Packaged validation:",
    manager?.snapshot(),
    "Fixture requests:",
    fixture.calls.map((call) => call.path),
  );
  throw error;
} finally {
  await manager?.dispose();
  await fixture.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}
