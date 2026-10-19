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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar } from "tar";
import { downloadRuntimePackage } from "../plugins/dsh-girl/release-runtime.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "DSG 仓库安装 "));
  const cache = join(root, "cache");
  const platform = "darwin",
    arch = "arm64",
    version = "test";
  const source = join(root, "source");
  await mkdir(join(source, "package/runtime"), { recursive: true });
  await writeFile(
    join(source, "package/package.json"),
    JSON.stringify({ name: "dsh-girl", version }),
  );
  await writeFile(
    join(source, "package/runtime.json"),
    JSON.stringify({ platform, arch, version, archive: "runtime/dsg.zip" }),
  );
  await writeFile(join(source, "package/runtime/dsg.zip"), "native component");
  await writeFile(
    join(source, "package/ignored.mjs"),
    "throw new Error('must not extract')",
  );
  const archive = join(root, "plugin.tgz");
  await createTar({ gzip: true, file: archive, cwd: source }, ["package"]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url =
    "https://github.com/moutsea/dsh-desk-buddy/releases/download/vtest/dsh-girl-test-darwin-arm64.tgz";
  const manifest = { version, packages: { "darwin-arm64": { url, sha256 } } };
  const save = () =>
    writeFile(join(root, "release-runtime.json"), JSON.stringify(manifest));
  await save();
  try {
    await run({
      root,
      cache,
      bytes,
      manifest,
      save,
      options: { platform, arch },
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

test("repository install selects the platform, verifies downloads and reuses the cache offline", async () => {
  await fixture(async ({ root, cache, bytes, manifest, options }) => {
    const fetcher = async (url) => {
      assert.equal(url, manifest.packages["darwin-arm64"].url);
      return new Response(bytes);
    };
    const [first, second] = await Promise.all([
      downloadRuntimePackage(root, cache, { ...options, fetcher }),
      downloadRuntimePackage(root, cache, { ...options, fetcher }),
    ]);
    assert.equal(first, second);
    assert.equal(
      await readFile(join(first, "runtime/dsg.zip"), "utf8"),
      "native component",
    );
    assert.deepEqual((await readdir(first)).sort(), [
      ".complete",
      "package.json",
      "runtime",
      "runtime.json",
    ]);
    const cached = await downloadRuntimePackage(root, cache, {
      ...options,
      fetcher: () => {
        throw new Error("offline");
      },
    });
    assert.equal(cached, first);
    assert.ok(
      (await readdir(join(cache, ".packages"))).every(
        (name) => !name.startsWith(".download-"),
      ),
    );
  });
});

test("download errors and integrity failures leave no partial runtime and can be retried", async () => {
  await fixture(async ({ root, cache, bytes, options }) => {
    await assert.rejects(
      downloadRuntimePackage(root, cache, {
        ...options,
        fetcher: async () => new Response("unavailable", { status: 503 }),
      }),
      /HTTP 503.*重试/,
    );
    await assert.rejects(
      downloadRuntimePackage(root, cache, {
        ...options,
        fetcher: async () => new Response("modified"),
      }),
      /校验失败/,
    );
    assert.deepEqual(await readdir(join(cache, ".packages")), []);
    await downloadRuntimePackage(root, cache, {
      ...options,
      fetcher: async () => new Response(bytes),
    });
  });
});

test("unsupported systems and invalid manifests are rejected before downloading", async () => {
  await fixture(async ({ root, cache, manifest, save, options }) => {
    const fetcher = () => assert.fail("must not download an invalid target");
    await assert.rejects(
      downloadRuntimePackage(root, cache, {
        platform: "linux",
        arch: "x64",
        fetcher,
      }),
      /暂未提供 linux\/x64/,
    );
    manifest.packages["darwin-arm64"].url = "https://example.com/component.tgz";
    await save();
    await assert.rejects(
      downloadRuntimePackage(root, cache, { ...options, fetcher }),
      /下载地址无效/,
    );
    manifest.packages["darwin-arm64"].sha256 = "invalid";
    await save();
    await assert.rejects(
      downloadRuntimePackage(root, cache, { ...options, fetcher }),
      /下载清单无效/,
    );
  });
});
