import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { x as extractTar } from "tar";
import {
  backupPlugin,
  findUpdate,
  newerVersion,
  PluginUpdater,
} from "../plugins/dsh-girl/updater.mjs";

test("rollback archives preserve source and bundled plugin entry points in Unicode paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "DSG 备份 中文 "));
  try {
    for (const bundled of [false, true]) {
      const root = join(directory, bundled ? "bundled" : "repository");
      const plugin = bundled ? root : join(root, "plugins/dsh-girl");
      await mkdir(plugin, { recursive: true });
      const manifest = {
        name: "dsh-desk-buddy",
        version: "0.12.3",
        files: bundled ? ["index.mjs", "runtime.json"] : ["plugins/dsh-girl"],
        ...(bundled ? { os: [process.platform] } : {}),
      };
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      if (!bundled)
        await writeFile(
          join(plugin, "package.json"),
          JSON.stringify({ name: manifest.name, version: manifest.version }),
        );
      await writeFile(
        join(plugin, "index.mjs"),
        "export const version = '0.12.3';",
      );
      const archive = await backupPlugin(plugin, directory);
      const unpacked = join(root, "restored");
      await mkdir(unpacked);
      await extractTar({ file: archive, cwd: unpacked });
      assert.deepEqual(
        JSON.parse(
          await readFile(join(unpacked, "package/package.json"), "utf8"),
        ),
        manifest,
      );
      assert.equal(
        await readFile(
          join(
            unpacked,
            "package",
            bundled ? "index.mjs" : "plugins/dsh-girl/index.mjs",
          ),
          "utf8",
        ),
        "export const version = '0.12.3';",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function releaseFixture(platform = "darwin", arch = "arm64") {
  const version = "0.12.4";
  const bytes = Buffer.from(
    "complete plugin archive, including host code and native runtime",
  );
  const filename = `dsh-desk-buddy-${version}-${platform}-${arch}.tgz`;
  const base = `https://github.com/moutsea/dsh-desk-buddy/releases/download/v${version}/`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const release = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: filename,
        browser_download_url: base + filename,
        size: bytes.length,
      },
      { name: "SHA256SUMS.txt", browser_download_url: base + "SHA256SUMS.txt" },
    ],
  };
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/latest")) return Response.json(release);
    if (url.endsWith("/SHA256SUMS.txt"))
      return new Response(`${sha256}  ${filename}\n`);
    assert.equal(url, base + filename);
    return new Response(bytes);
  };
  return { version, release, bytes, fetcher, calls, platform, arch };
}

test("release comparison handles numeric components and never offers a downgrade or prerelease", async () => {
  assert.equal(newerVersion("0.12.10", "0.12.9"), true);
  assert.equal(newerVersion("1.0.0", "0.99.99"), true);
  assert.equal(newerVersion("0.12.3", "0.12.3"), false);
  assert.equal(newerVersion("0.12.3", "0.13.0"), false);
  assert.throws(() => newerVersion("0.12.4-rc.1", "0.12.3"));
  const fixture = releaseFixture();
  assert.equal(await findUpdate("0.12.4", fixture), null);
  assert.equal(fixture.calls.length, 1);
  fixture.release.prerelease = true;
  await assert.rejects(findUpdate("0.12.3", fixture), /正式版本/);
});

test("each supported platform requires its exact release asset and one valid checksum", async () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["win32", "x64"],
  ]) {
    const fixture = releaseFixture(platform, arch);
    const update = await findUpdate("0.12.3", fixture);
    assert.match(update.filename, new RegExp(`${platform}-${arch}\\.tgz$`));
    assert.equal(fixture.calls.length, 2);
    fixture.release.assets[0].browser_download_url =
      "https://example.com/other.tgz";
    await assert.rejects(findUpdate("0.12.3", fixture), /完整更新包/);
  }
  await assert.rejects(
    findUpdate("0.12.3", releaseFixture("linux", "x64")),
    /当前支持/,
  );
  const fixture = releaseFixture();
  await assert.rejects(
    findUpdate("0.12.3", {
      ...fixture,
      fetcher: async (url) =>
        url.endsWith("/latest")
          ? fixture.fetcher(url)
          : new Response("invalid"),
    }),
    /校验值/,
  );
  await assert.rejects(
    findUpdate("0.12.3", {
      ...fixture,
      fetcher: async () => new Response("rate limited", { status: 403 }),
    }),
    /限制了请求/,
  );
});

async function withUpdater(run) {
  const storage = await mkdtemp(join(tmpdir(), "DSG 更新 中文 "));
  const fixture = releaseFixture();
  const installs = [];
  const service = {
    installBundle: async (archive, options) => {
      assert.deepEqual(await readFile(archive), fixture.bytes);
      installs.push({ archive, options });
      return {
        application: "restart-required",
        bundle: "dsh-desk-buddy",
        version: fixture.version,
      };
    },
  };
  const updater = new PluginUpdater({
    ...fixture,
    version: "0.12.3",
    storage,
    service: () => service,
  });
  try {
    await run({ storage, fixture, service, updater, installs });
  } finally {
    await updater.dispose();
    await rm(storage, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

test("manual update is serialized, retains the complete archive and preferences, and waits for a host restart", async () => {
  await withUpdater(async ({ updater, storage, installs, fixture }) => {
    await mkdir(join(storage, "settings"));
    await writeFile(
      join(storage, "settings/settings.json"),
      '{"selectedId":"keep-my-chat"}',
    );
    await writeFile(join(storage, "preferences.json"), '{"autoStart":false}');
    assert.equal(fixture.calls.length, 0);
    assert.throws(() => updater.install(fixture.version), /先检查/);
    assert.equal(updater.check().phase, "checking");
    assert.throws(() => updater.check(), /请稍候/);
    await updater.operation;
    assert.equal(updater.snapshot().phase, "available");
    assert.throws(() => updater.install("9.0.0"), /先检查/);
    assert.equal(updater.install(fixture.version).phase, "downloading");
    assert.throws(() => updater.install(fixture.version), /请稍候/);
    await updater.operation;
    assert.equal(updater.snapshot().phase, "restart-required");
    assert.equal(updater.snapshot().currentVersion, "0.12.3");
    assert.equal(updater.snapshot().downloaded, fixture.bytes.length);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].options.enabled, true);
    assert.equal(installs[0].options.saveExact, true);
    assert.equal((await readdir(join(storage, "updates"))).length, 1);
    assert.equal(
      await readFile(join(storage, "preferences.json"), "utf8"),
      '{"autoStart":false}',
    );
    assert.equal(
      await readFile(join(storage, "settings/settings.json"), "utf8"),
      '{"selectedId":"keep-my-chat"}',
    );
    assert.throws(() => updater.check(), /重启/);
  });
});

test("bad downloads never reach the host and an explicit retry succeeds", async () => {
  await withUpdater(async ({ updater, fixture, installs, storage }) => {
    updater.check();
    await updater.operation;
    updater.fetcher = async () => new Response("damaged download");
    updater.install(fixture.version);
    await updater.operation;
    assert.equal(updater.snapshot().phase, "error");
    assert.match(updater.snapshot().error, /校验失败/);
    assert.equal(installs.length, 0);
    assert.deepEqual(await readdir(join(storage, "updates")), []);
    updater.fetcher = fixture.fetcher;
    updater.install(fixture.version);
    await updater.operation;
    assert.equal(updater.snapshot().phase, "restart-required");
  });
});

test("host failures remain retryable without exposing package-manager diagnostics", async () => {
  await withUpdater(async ({ updater, fixture, service }) => {
    updater.check();
    await updater.operation;
    const install = service.installBundle;
    service.installBundle = async () => ({
      application: "failed",
      error: { code: "incompatible-version", diagnostic: "private" },
    });
    updater.install(fixture.version);
    await updater.operation;
    assert.match(updater.snapshot().error, /不兼容/);
    assert.ok(!JSON.stringify(updater.snapshot()).includes("private"));
    service.installBundle = install;
    updater.install(fixture.version);
    await updater.operation;
    assert.equal(updater.snapshot().phase, "restart-required");
  });
});

test("unload cancels a download and unsupported hosts expose an explanation", async () => {
  await withUpdater(async ({ updater, fixture, installs }) => {
    updater.check();
    await updater.operation;
    let entered;
    const downloading = new Promise((resolve) => {
      entered = resolve;
    });
    updater.fetcher = async (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        entered();
      });
    updater.install(fixture.version);
    await downloading;
    await updater.dispose();
    assert.equal(installs.length, 0);
    assert.match(updater.snapshot().error, /取消/);
    assert.throws(() => updater.check(), /停用/);
  });
  const unavailable = new PluginUpdater({
    version: "0.12.3",
    service: () => null,
  });
  assert.match(unavailable.snapshot().unavailable, /更新接口/);
  assert.throws(() => unavailable.check(), /更新接口/);
  unavailable.service = () => ({ installBundle() {} });
  unavailable.hotReload = () => true;
  assert.throws(() => unavailable.check(), /完整的插件更新接口/);
});

test("hot-reload hosts replace through official removal and restore the old plugin on failure", async () => {
  for (const scenario of [
    { failure: false, removal: "restart-required" },
    { failure: true, removal: "restart-required" },
    { failure: false, removal: "applied" },
    { failure: true, removal: "applied" },
  ]) {
    const { failure, removal } = scenario;
    await withUpdater(async ({ updater, fixture, service }) => {
      const calls = [];
      let installed = true;
      updater.hotReload = () => true;
      updater.backup = async () => "rollback.tgz";
      service.listBundles = async () =>
        installed
          ? [{ name: "dsh-desk-buddy", removable: true, installed }]
          : [];
      service.removeBundle = async (name) => {
        calls.push(["remove", name]);
        await updater.dispose();
        installed = false;
        return { application: removal };
      };
      service.installBundle = async (archive) => {
        calls.push(["install", archive]);
        installed = true;
        if (failure && archive !== "rollback.tgz")
          return {
            application: "failed",
            error: { code: "incompatible-version" },
          };
        return {
          application: "applied",
          bundle: "dsh-desk-buddy",
          version: archive === "rollback.tgz" ? "0.12.3" : fixture.version,
        };
      };
      updater.check();
      await updater.operation;
      updater.install(fixture.version);
      await updater.operation;
      assert.equal(updater.phase, failure ? "error" : "restart-required");
      assert.equal(installed, true);
      assert.equal(updater.abort.signal.aborted, false);
      assert.deepEqual(calls[0], ["remove", "dsh-desk-buddy"]);
      assert.equal(calls.length, failure ? 4 : 2);
      if (failure) {
        assert.match(updater.error, /已恢复旧版/);
        assert.ok(!updater.error.includes("网络"));
      }
    });
  }
});

test("failed or cancelled removal never installs the new version", async () => {
  for (const result of [
    { application: "failed" },
    { application: "cancelled" },
    { application: "restart-required", error: { code: "permission" } },
  ]) {
    await withUpdater(async ({ updater, fixture, service }) => {
      let installed = true;
      const archives = [];
      updater.hotReload = () => true;
      updater.backup = async () => "rollback.tgz";
      service.listBundles = async () =>
        installed
          ? [{ name: "dsh-desk-buddy", removable: true, installed }]
          : [];
      service.removeBundle = async () => {
        installed = false;
        return result;
      };
      service.installBundle = async (archive) => {
        archives.push(archive);
        return {
          application: "restart-required",
          bundle: "dsh-desk-buddy",
          version: "0.12.3",
        };
      };
      updater.check();
      await updater.operation;
      updater.install(fixture.version);
      await updater.operation;
      assert.equal(updater.phase, "error");
      assert.match(updater.error, /未能卸载旧插件/);
      assert.deepEqual(archives, ["rollback.tgz"]);
    });
  }
});

test("failed removal re-enables the intact old bundle without retrying broken pnpm operations", async () => {
  for (const application of ["applied", "restart-required"]) {
    await withUpdater(async ({ updater, fixture, service, installs }) => {
      let enabled = true;
      let removals = 0;
      const activations = [];
      updater.hotReload = () => true;
      updater.backup = async () => "rollback.tgz";
      service.listBundles = async () => [
        {
          name: "dsh-desk-buddy",
          version: updater.version,
          removable: true,
          installed: true,
          enabled,
        },
      ];
      service.removeBundle = async () => {
        removals++;
        enabled = false;
        await updater.dispose();
        return {
          application: "failed",
          error: { code: "operation-error" },
          packageResult: {
            output: "[ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY] private diagnostic",
          },
        };
      };
      service.setBundleEnabled = async (...args) => {
        activations.push(args);
        enabled = args[1];
        return { application };
      };
      updater.check();
      await updater.operation;
      updater.install(fixture.version);
      await updater.operation;
      assert.equal(updater.phase, "error");
      assert.equal(enabled, true);
      assert.equal(removals, 1);
      assert.equal(installs.length, 0);
      assert.deepEqual(activations, [["dsh-desk-buddy", true]]);
      assert.match(updater.error, /依赖锁文件不完整.*已恢复旧版/);
      assert.ok(!updater.error.includes("private"));
    });
  }
});

test("failed reactivation preserves the original cause without claiming restoration succeeded", async () => {
  for (const failure of ["missing", "failed", "cancelled", "throws"]) {
    await withUpdater(async ({ updater, fixture, service, installs }) => {
      let removals = 0;
      updater.hotReload = () => true;
      updater.backup = async () => "rollback.tgz";
      service.listBundles = async () => [
        {
          name: "dsh-desk-buddy",
          version: updater.version,
          removable: true,
          installed: true,
          enabled: false,
        },
      ];
      service.removeBundle = async () => {
        removals++;
        return {
          application: "failed",
          error: {
            code: "operation-error",
            diagnostic: "[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] private",
          },
        };
      };
      if (failure !== "missing")
        service.setBundleEnabled = async () => {
          if (failure === "throws") throw new Error("private activation error");
          return { application: failure };
        };
      updater.check();
      await updater.operation;
      updater.install(fixture.version);
      await updater.operation;
      assert.equal(updater.phase, "error");
      assert.equal(removals, 1);
      assert.equal(installs.length, 0);
      assert.match(updater.error, /发布时间要求.*旧版自动恢复未完成/);
      assert.ok(!updater.error.includes("已恢复旧版"));
      assert.ok(!updater.error.includes("private"));
    });
  }
});
