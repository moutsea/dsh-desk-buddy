import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  readFile,
  mkdir,
  access,
  rename,
  rm,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { extractArchive } from "./archive.mjs";
import {
  downloadRuntimePackage,
  assertPackageVersion,
} from "./release-runtime.mjs";

export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}
function inside(base, path) {
  const result = resolve(base, path);
  if (!result.startsWith(resolve(base) + sep))
    throw new Error("桌宠组件路径无效");
  return result;
}
export async function prepareRuntime(root, cache) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("桌宠组件清单无效", { cause: error });
    const packageRoot = await downloadRuntimePackage(root, cache);
    return prepareRuntime(packageRoot, cache);
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error(
      `此插件包适用于 ${manifest.platform}/${manifest.arch}，请安装适合当前电脑的桌宠插件包`,
    );
  await assertPackageVersion(root, manifest);
  if (!["darwin", "win32"].includes(process.platform))
    throw new Error("此版本的插件安装器目前支持 macOS 和 Windows");
  if (
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !/^[\w.-]+$/.test(manifest.version)
  )
    throw new Error("桌宠组件清单无效");
  const archive = inside(root, manifest.archive);
  const destination = join(
    cache,
    `${manifest.version}-${manifest.sha256.slice(0, 16)}`,
  );
  const executable = inside(destination, manifest.executable);
  const executableMode =
    process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    if (
      (await readFile(join(destination, ".complete"), "utf8")) ===
      manifest.sha256
    ) {
      await access(executable, executableMode);
      return { executable, version: manifest.version };
    }
  } catch {}
  if ((await fileHash(archive)) !== manifest.sha256)
    throw new Error("桌宠组件校验失败，请重新安装桌宠插件包");
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".install-"));
  try {
    await extractArchive(archive, staging);
    await access(inside(staging, manifest.executable), executableMode);
    await writeFile(join(staging, ".complete"), manifest.sha256);
    try {
      await rename(staging, destination);
    } catch (error) {
      const collisions =
        process.platform === "win32"
          ? ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]
          : ["EEXIST", "ENOTEMPTY"];
      if (!collisions.includes(error.code)) throw error;
      // Another host may have installed this immutable component concurrently.
      // Keep its complete runtime in place; it may already be executing.
      if (
        (await readFile(join(destination, ".complete"), "utf8")) !==
        manifest.sha256
      )
        throw new Error(
          "桌宠组件缓存不完整，请清理桌宠的 runtime 缓存后重新启动",
        );
      await access(executable, executableMode);
    }
    return { executable, version: manifest.version };
  } finally {
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
