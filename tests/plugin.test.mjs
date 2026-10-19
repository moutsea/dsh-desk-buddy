import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  chmod,
  symlink,
  readlink,
  access,
  copyFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  DesktopManager,
  desktopEnvironment,
} from "../plugins/dsh-girl/manager.mjs";
import {
  apply,
  localRequest,
  usesDesktopProtocol,
} from "../plugins/dsh-girl/index.mjs";
import { prepareRuntime, fileHash } from "../plugins/dsh-girl/runtime.mjs";
import { createArchive } from "../plugins/dsh-girl/archive.mjs";
import { managedLaunch } from "../electron/managed.mjs";

const endpoint = "http://127.0.0.1:3080";
const runtime = async () => ({
  executable: process.execPath,
  args: [resolve("tests/helpers/managed-child.mjs")],
  version: "test",
});
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("managed child did not reach expected state");
}

test("managed launch validates local endpoints and strips credentials and Node/Electron overrides", () => {
  assert.equal(managedLaunch({}), null);
  assert.throws(() => managedLaunch({ DEEPSEEK_GIRL_MANAGED: "1" }));
  assert.throws(() =>
    managedLaunch({
      DEEPSEEK_GIRL_MANAGED: "1",
      DEEPSEEK_GIRL_DATA_DIR: "/tmp/dsg",
      DEEPSEEK_GIRL_ENDPOINT: "https://evil.test",
    }),
  );
  const env = desktopEnvironment(endpoint, "/tmp/dsg", {
    HOME: "/home/me",
    PATH: "/usr/bin",
    DEEPSEEK_API_KEY: "private",
    OTHER_TOKEN: "private",
    NODE_OPTIONS: "private",
    ELECTRON_RUN_AS_NODE: "1",
    node_options: "private",
    DEEPSEEK_GIRL_DEV_URL: "https://evil.test",
  });
  assert.equal(env.HOME, "/home/me");
  assert.deepEqual(managedLaunch(env), { endpoint });
  assert.ok(!JSON.stringify(env).includes("private"));
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.DEEPSEEK_GIRL_DEV_URL, undefined);
});

test("manager coalesces starts, controls only its child and gracefully stops it", async () => {
  const storage = await mkdtemp(join(tmpdir(), "dsg-manager-"));
  let prepares = 0;
  const manager = new DesktopManager({
    endpoint,
    storage,
    root: storage,
    autoStart: false,
    runtime: async () => {
      prepares++;
      return runtime();
    },
  });
  try {
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    assert.equal(a.pid, b.pid);
    assert.equal(prepares, 1);
    await eventually(() => manager.connection === "connected");
    await manager.control("hide");
    await eventually(() => !manager.visible);
    await manager.control("show");
    await eventually(() => manager.visible);
    await assert.rejects(manager.control("execute", "rm"), /未知/);
    const child = manager.child;
    await manager.stop();
    assert.equal(child.exitCode, 0);
    assert.equal(manager.snapshot().pid, null);
    assert.equal(manager.phase, "stopped");
  } finally {
    await manager.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});

test("auto-start preference persists, user exit is respected and dispose cancels an in-flight install", async () => {
  const storage = await mkdtemp(join(tmpdir(), "dsg-preference-"));
  let release, entered;
  const installing = new Promise((resolve) => {
    entered = resolve;
  });
  const manager = new DesktopManager({
    endpoint,
    storage,
    root: storage,
    runtime: async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return runtime();
    },
  });
  try {
    await manager.control("autoStart", false);
    const other = new DesktopManager({
      endpoint,
      storage,
      root: storage,
      runtime,
    });
    await other.init();
    assert.equal(other.phase, "stopped");
    assert.equal(other.autoStart, false);
    await other.start();
    other.controlStream.end();
    await eventually(() => other.phase === "stopped");
    await other.dispose();
    const started = manager.start();
    await installing;
    const rejected = assert.rejects(started, /停用/);
    const stopped = manager.dispose();
    release();
    await rejected;
    await stopped;
    assert.equal(manager.child, null);
    assert.equal(manager.phase, "stopped");
    await assert.rejects(manager.start(), /停用/);
  } finally {
    await manager.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});

test("missing executables report failure without orphan processes or hanging cleanup", async () => {
  const storage = await mkdtemp(join(tmpdir(), "dsg-bad-runtime-"));
  const manager = new DesktopManager({
    endpoint,
    storage,
    root: storage,
    runtime: async () => ({ executable: join(storage, "missing") }),
  });
  try {
    await assert.rejects(manager.start(), /无法启动/);
    assert.equal(manager.phase, "error");
    assert.equal(manager.child, null);
  } finally {
    await manager.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});

test("runtime installer rejects source-only packages, incompatible platforms and changed archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsg-runtime-"));
  try {
    await assert.rejects(prepareRuntime(root, join(root, "cache")), /未包含/);
    const manifest = { platform: "different-platform", arch: process.arch };
    await writeFile(join(root, "runtime.json"), JSON.stringify(manifest));
    await assert.rejects(prepareRuntime(root, join(root, "cache")), /适用于/);
    if (!["darwin", "win32"].includes(process.platform)) return;
    Object.assign(manifest, {
      platform: process.platform,
      version: "test",
      archive: "runtime.zip",
      executable: "DSG.app/Contents/MacOS/DSG",
      sha256: "a".repeat(64),
    });
    await writeFile(join(root, "runtime.json"), JSON.stringify(manifest));
    await writeFile(join(root, "runtime.zip"), "modified");
    await assert.rejects(prepareRuntime(root, join(root, "cache")), /校验失败/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "concurrent runtime installs preserve executable permissions, framework symlinks and a complete cache",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dsg-concurrent-install-"));
    try {
      const app = join(root, "Tiny.app"),
        executable = "Tiny.app/Contents/MacOS/Tiny";
      await mkdir(join(app, "Contents/MacOS"), { recursive: true });
      await mkdir(join(app, "Contents/Frameworks/Test.framework/Versions/A"), {
        recursive: true,
      });
      await writeFile(join(root, executable), "#!/bin/sh\nexit 0\n");
      await chmod(join(root, executable), 0o755);
      await symlink(
        "A",
        join(app, "Contents/Frameworks/Test.framework/Versions/Current"),
      );
      const archive = join(root, "runtime.zip");
      await promisify(execFile)("/usr/bin/ditto", [
        "-c",
        "-k",
        "--keepParent",
        app,
        archive,
      ]);
      await writeFile(
        join(root, "runtime.json"),
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          version: "test",
          archive: "runtime.zip",
          executable,
          sha256: await fileHash(archive),
        }),
      );
      const [a, b] = await Promise.all([
        prepareRuntime(root, join(root, "cache")),
        prepareRuntime(root, join(root, "cache")),
      ]);
      assert.equal(a.executable, b.executable);
      await access(a.executable, constants.X_OK);
      assert.equal(
        await readlink(
          resolve(
            a.executable,
            "../../Frameworks/Test.framework/Versions/Current",
          ),
        ),
        "A",
      );
      assert.deepEqual(await prepareRuntime(root, join(root, "cache")), a);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows installs concurrently, preserves Unicode paths and runs the extracted executable",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "DSG 测试 ' & "));
    try {
      const source = join(root, "Desk Buddy"),
        executable = "Desk Buddy/Buddy.exe",
        archive = join(root, "runtime.zip");
      await mkdir(source);
      await copyFile(process.execPath, join(root, executable));
      await writeFile(join(source, "资源.json"), '{"完整":true}');
      await createArchive(source, archive);
      await writeFile(
        join(root, "runtime.json"),
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          version: "test",
          archive: "runtime.zip",
          executable,
          sha256: await fileHash(archive),
        }),
      );
      const [first, second] = await Promise.all([
        prepareRuntime(root, join(root, "cache")),
        prepareRuntime(root, join(root, "cache")),
      ]);
      assert.deepEqual(first, second);
      assert.deepEqual(await prepareRuntime(root, join(root, "cache")), first);
      const result = await promisify(execFile)(first.executable, ["--version"]);
      assert.equal(result.stdout.trim(), process.version);
      assert.equal(
        await readFile(join(first.executable, "../资源.json"), "utf8"),
        '{"完整":true}',
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
);

test("plugin serves a discoverable manager and rejects cross-origin, remote and oversized control requests", async () => {
  const storage = await mkdtemp(join(tmpdir(), "dsg-routes-"));
  const routes = [],
    disposers = [];
  let inject;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const route =
      routes.find((route) => route.kind === "exact" && route.path === path) ||
      routes.find(
        (route) =>
          route.kind === "prefix" &&
          (path === route.path || path.startsWith(route.path + "/")),
      );
    if (route) await route.handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port,
    base = `http://127.0.0.1:${port}`;
  try {
    await apply(
      {
        credentials: { resolve: async () => null },
        webServer: {
          port,
          register: (route) => {
            routes.push(route);
            return () => routes.splice(routes.indexOf(route), 1);
          },
          tapIndex: (tap) => {
            inject = tap;
            return () => {
              inject = null;
            };
          },
        },
        effect: (effect) => disposers.push(effect()),
        logger: { warn() {} },
      },
      { storageRoot: storage, autoStart: false },
    );
    assert.match(inject("<html><body></body></html>"), /dsh-girl\/launcher.js/);
    const page = await fetch(base + "/dsh-girl/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /启动 DSG/);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'self'/,
    );
    const state = await fetch(base + "/dsh-girl/status.json").then((response) =>
      response.json(),
    );
    assert.equal(state.endpoint, base);
    assert.equal(state.autoStart, false);
    const control = (body, extra = {}) =>
      fetch(base + "/dsh-girl/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extra },
        body,
      });
    assert.equal(
      (await control('{"action":"stop"}', { Origin: "https://evil.test" }))
        .status,
      403,
    );
    assert.equal(
      localRequest(
        {
          headers: { host: `127.0.0.1:${port}` },
          socket: { remoteAddress: "192.0.2.2" },
        },
        port,
      ),
      false,
    );
    assert.equal((await control('{"action":"execute"}')).status, 400);
    assert.equal((await control("{".repeat(5000))).status, 413);
    assert.equal(
      (await control('{"action":"autoStart","value":true}')).status,
      200,
    );
    assert.equal(
      JSON.parse(await readFile(join(storage, "preferences.json"), "utf8"))
        .autoStart,
      true,
    );
    assert.equal(
      (
        await fetch(base + "/dsh-girl/balance.json").then((response) =>
          response.json(),
        )
      ).code,
      "NO_KEY",
    );
    assert.equal(
      (await control('{"action":"autoStart","value":"yes"}')).status,
      400,
    );
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    assert.equal(routes.length, 0);
    assert.equal(inject, null);
    await new Promise((resolve) => server.close(resolve));
    await rm(storage, { recursive: true, force: true });
  }
});

test("Desktop startup injection registers before the port binds and deferred startup is cancelled on unload", async () => {
  const storage = await mkdtemp(join(tmpdir(), "dsg-desktop-boot-"));
  const routes = [],
    cleanups = [],
    listeners = new Map();
  const webServer = {
    port: undefined,
    register: (route) => {
      routes.push(route);
      return () => routes.splice(routes.indexOf(route), 1);
    },
    collectIndexInjections() {},
    tapIndex() {
      assert.fail("Desktop must use its structured boot injection table");
    },
  };
  try {
    await apply(
      {
        webServer,
        credentials: { resolve: async () => null },
        get: () => undefined,
        on: (event, handler) => {
          listeners.set(event, handler);
        },
        effect: (effect) => cleanups.push(effect()),
        logger: { warn() {} },
      },
      { storageRoot: storage, autoStart: false },
    );
    const rows = [];
    listeners.get("webserver/index-inject")(rows);
    assert.deepEqual(rows, [
      { kind: "script-src", placement: "body", src: "/dsh-girl/launcher.js" },
    ]);
    assert.equal(routes.length, 2);
    // Disposing a not-yet-bound Host must not leave a wait that starts a child later.
    for (const cleanup of cleanups.reverse()) await cleanup();
    webServer.port = 32199;
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.equal(routes.length, 0);
    await assert.rejects(readFile(join(storage, "preferences.json")), /ENOENT/);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("protocol detection distinguishes legacy same-name gateways from Desktop Peer transport", () => {
  assert.equal(
    usesDesktopProtocol({ get: () => ({ invoke() {} }), connection: {} }),
    false,
  );
  assert.equal(
    usesDesktopProtocol({
      get: () => ({ wireStream: { open() {} } }),
      connection: {},
    }),
    false,
  );
  assert.equal(
    usesDesktopProtocol({
      get: () => ({ wireStream: { open() {} } }),
      connection: { createPeer() {} },
    }),
    true,
  );
});
