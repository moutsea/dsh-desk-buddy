import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { t as listTar } from "tar";
import { fileHash } from "../plugins/dsh-girl/runtime.mjs";

export const releaseTargets = ["darwin-arm64", "win32-x64"];
export const manifestPath = "plugins/dsh-girl/release-runtime.json";

export async function artifactManifest(pkg, archives) {
  const packages = {};
  for (const [target, file] of Object.entries(archives)) {
    assert(releaseTargets.includes(target), "Unsupported release target");
    const metadata = new Map();
    let invalidMetadata = false;
    await listTar({
      file,
      onReadEntry(entry) {
        if (
          !["package/package.json", "package/runtime.json"].includes(entry.path)
        )
          return;
        if (entry.size > 65536 || metadata.has(entry.path)) {
          invalidMetadata = true;
          return;
        }
        const chunks = [];
        metadata.set(entry.path, chunks);
        entry.on("data", (chunk) => chunks.push(chunk));
      },
    });
    assert(!invalidMetadata, "Invalid artifact metadata");
    const parse = (path) =>
      JSON.parse(Buffer.concat(metadata.get(path) || []).toString());
    const plugin = parse("package/package.json"),
      runtime = parse("package/runtime.json");
    assert.equal(plugin.name, pkg.name, "Artifact package name mismatch");
    assert.equal(
      plugin.version,
      pkg.version,
      "Artifact package version mismatch",
    );
    assert.equal(
      runtime.version,
      pkg.version,
      "Artifact runtime version mismatch",
    );
    assert.equal(
      `${runtime.platform}-${runtime.arch}`,
      target,
      "Artifact platform mismatch",
    );
    assert.equal(runtime.archive, "runtime/dsg.zip");
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    packages[target] = {
      url: `https://github.com/moutsea/dsh-desk-buddy/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}-${target}.tgz`,
      sha256: await fileHash(file),
    };
  }
  return { version: pkg.version, packageName: pkg.name, packages };
}

export async function releaseManifest(root, directory) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(
    await readFile(join(root, "plugins/dsh-girl/package.json"), "utf8"),
  );
  assert.equal(plugin.version, pkg.version, "Source plugin version mismatch");
  assert.equal(plugin.name, pkg.name, "Source plugin name mismatch");
  return artifactManifest(
    pkg,
    Object.fromEntries(
      releaseTargets.map((target) => [
        target,
        join(directory, `${pkg.name}-${pkg.version}-${target}.tgz`),
      ]),
    ),
  );
}
