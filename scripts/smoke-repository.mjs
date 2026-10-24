import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { artifactManifest } from "./release-artifacts.mjs";
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
const originalFetch = globalThis.fetch;
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
  const metadata = JSON.parse(
    await readFile(require.resolve(`${pkg.name}/package.json`), "utf8"),
  );
  assert.equal(metadata.icon, "./plugins/dsh-girl/web/icon.png");
  assert.ok(
    (await readFile(require.resolve(`${pkg.name}/icon`))).length < 256 * 1024,
  );
  assert.ok(entry.endsWith(join("plugins", "dsh-girl", "index.mjs")));
  const plugin = await import(pathToFileURL(entry).href);
  assert.equal(typeof plugin.apply, "function");
  const root = dirname(entry);
  let release = JSON.parse(
    await readFile(join(root, "release-runtime.json"), "utf8"),
  );
  if (process.env.DSG_REPOSITORY_REMOTE !== "1") {
    // Validate this candidate before its Release exists, exercising the real
    // streaming downloader and checksum/extraction path with the tested tgz.
    const target = `${process.platform}-${process.arch}`;
    const archive =
      process.env.DSG_PLUGIN_PACKAGE ||
      `release/${pkg.name}-${pkg.version}-${target}.tgz`;
    release = await artifactManifest(pkg, { [target]: archive });
    await writeFile(
      join(root, "release-runtime.json"),
      JSON.stringify(release),
    );
    globalThis.fetch = (url, options) =>
      String(url) === release.packages[target].url
        ? Promise.resolve(
            new Response(Readable.toWeb(createReadStream(archive))),
          )
        : originalFetch(url, options);
  }
  assert.equal(metadata.version, release.version);
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
  // The service can connect before Electron's initial ready-to-show callback.
  // Start visibility controls from a shown window, as the packaged smoke does.
  await expect.poll(() => manager.visible, { timeout: 15000 }).toBe(true);
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
        downloadSource:
          process.env.DSG_REPOSITORY_REMOTE === "1"
            ? "published-release"
            : "local-candidate",
        connection: "connected",
        restart: true,
        modelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    `Repository entry passed on ${process.platform}/${process.arch}: plugin export, verified component download, native launch, connection, visibility controls and cached restart.`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await manager?.dispose();
  await fixture.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}
