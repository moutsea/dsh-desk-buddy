import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import { createFixture } from "../tests/fixture.mjs";

const exec = promisify(execFile);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const directory = await mkdtemp(join(tmpdir(), "DSG 仓库安装 "));
const fixture = await createFixture();
let manager;
try {
  assert.ok(process.env.npm_execpath, "请通过 npm run test:repository 运行");
  const packed = await exec(
    process.execPath,
    [
      process.env.npm_execpath,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ],
    { maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const [result] = JSON.parse(packed.stdout);
  assert.ok(
    result.size < 1024 * 1024,
    "repository entry must not include app binaries or artwork",
  );
  await mkdir(join(directory, "profile"));
  await writeFile(
    join(directory, "profile/package.json"),
    JSON.stringify({ name: "dsg-repository-smoke", private: true }),
  );
  await exec(
    process.execPath,
    [
      process.env.npm_execpath,
      "install",
      "--prefix",
      join(directory, "profile"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(directory, result.filename),
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const require = createRequire(join(directory, "profile/package.json"));
  const entry = require.resolve(pkg.name);
  assert.ok(entry.endsWith(join("plugins", "dsh-girl", "index.mjs")));
  const plugin = await import(pathToFileURL(entry).href);
  assert.equal(typeof plugin.apply, "function");
  const root = dirname(entry);
  const release = JSON.parse(
    await readFile(join(root, "release-runtime.json"), "utf8"),
  );
  const { DesktopManager } = await import(
    pathToFileURL(join(root, "manager.mjs")).href
  );
  const storage = join(directory, "storage");
  await mkdir(join(storage, "settings"), { recursive: true });
  await writeFile(
    join(storage, "settings/settings.json"),
    JSON.stringify({ alwaysOnTop: false }),
  );
  manager = new DesktopManager({ endpoint: fixture.endpoint, root, storage });
  await manager.start();
  await expect
    .poll(() => manager.connection, { timeout: 45000 })
    .toBe("connected");
  assert.equal(manager.version, release.version);
  await manager.control("hide");
  await expect.poll(() => manager.visible).toBe(false);
  await manager.control("show");
  await expect.poll(() => manager.visible).toBe(true);
  await manager.stop();
  await manager.start();
  await expect
    .poll(() => manager.connection, { timeout: 45000 })
    .toBe("connected");
  await manager.stop();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/repository-install-result.json",
    JSON.stringify(
      {
        version: pkg.version,
        runtimeVersion: release.version,
        platform: process.platform,
        arch: process.arch,
        bootstrapPackage: true,
        releaseDownload: true,
        connection: "connected",
        restart: true,
        modelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    `Repository entry passed on ${process.platform}/${process.arch}: plugin export, Release download, native launch, connection, visibility controls and cached restart.`,
  );
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
