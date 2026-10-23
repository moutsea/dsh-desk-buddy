import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { c as packTar } from "tar";
import {
  releaseTargets,
  releaseManifest,
  manifestPath,
} from "../scripts/release-artifacts.mjs";

test("release manifest is generated from matching platform artifacts and rejects version/hash mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsg-release-"));
  const pkg = { name: "dsh-desk-buddy", version: "1.2.3" };
  const script = resolve("scripts/release-manifest.mjs");
  const run = (mode) =>
    promisify(execFile)(process.execPath, [script, mode, "artifacts"], {
      cwd: root,
    });
  try {
    await mkdir(join(root, "plugins/dsh-girl"), { recursive: true });
    await mkdir(join(root, "artifacts"));
    await mkdir(join(root, "package"));
    for (const path of [
      "package.json",
      "plugins/dsh-girl/package.json",
      "package/package.json",
    ])
      await writeFile(join(root, path), JSON.stringify(pkg));
    const make = async (target, version = pkg.version) => {
      const [platform, arch] = target.split("-");
      await writeFile(
        join(root, "package/runtime.json"),
        JSON.stringify({
          platform,
          arch,
          version,
          archive: "runtime/dsg.zip",
          sha256: "a".repeat(64),
        }),
      );
      await packTar(
        {
          cwd: root,
          gzip: true,
          file: join(
            root,
            "artifacts",
            `${pkg.name}-${pkg.version}-${target}.tgz`,
          ),
        },
        ["package"],
      );
    };
    for (const target of releaseTargets) await make(target);
    const manifest = await releaseManifest(root, join(root, "artifacts"));
    assert.equal(Object.keys(manifest.packages).length, 2);
    assert.equal(manifest.version, pkg.version);
    await run("write");
    await run("check");
    assert.deepEqual(
      JSON.parse(await readFile(join(root, manifestPath), "utf8")),
      manifest,
    );
    manifest.packages["darwin-arm64"].sha256 = "0".repeat(64);
    await writeFile(join(root, manifestPath), JSON.stringify(manifest));
    await assert.rejects(run("check"), /Tagged manifest must match/);
    await make("win32-x64", "older");
    await assert.rejects(
      releaseManifest(root, join(root, "artifacts")),
      /runtime version mismatch/,
    );
    await writeFile(
      join(root, "plugins/dsh-girl/package.json"),
      JSON.stringify({ ...pkg, version: "older" }),
    );
    await assert.rejects(
      releaseManifest(root, join(root, "artifacts")),
      /Source plugin version mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
