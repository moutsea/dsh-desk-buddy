import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { manifestPath, releaseManifest } from "./release-artifacts.mjs";

const mode = process.argv[2],
  directory = resolve(process.argv[3] || "release");
assert(
  ["write", "check"].includes(mode),
  "Use: node scripts/release-manifest.mjs write|check [artifact-directory]",
);
const manifest = await releaseManifest(process.cwd(), directory);
if (mode === "write")
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
else
  assert.deepEqual(
    JSON.parse(await readFile(manifestPath, "utf8")),
    manifest,
    "Tagged manifest must match the tested artifacts; regenerate it before tagging",
  );
console.log(
  `${mode}: ${manifest.version}, verified both platform packages and SHA-256 values`,
);
