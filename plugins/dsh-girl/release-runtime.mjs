import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x as extractTar } from "tar";

export async function downloadVerifiedPackage(
  asset,
  archive,
  {
    fetcher = fetch,
    signal = AbortSignal.timeout(300000),
    onProgress = () => {},
  } = {},
) {
  const response = await fetcher(asset.url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024)
        return callback(new Error("桌宠组件下载大小超出限制"));
      hash.update(chunk);
      onProgress(bytes);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verify,
    createWriteStream(archive, { flags: "wx" }),
    { signal },
  );
  if (hash.digest("hex") !== asset.sha256)
    throw new Error("桌宠组件下载校验失败");
}

export async function assertPackageVersion(root, manifest) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    !pkg.version ||
    pkg.version !== manifest.version ||
    (manifest.packageName && pkg.name !== manifest.packageName)
  )
    throw new Error(
      "插件与桌宠组件清单版本不一致，请重新安装对应版本的完整插件包",
    );
}

export async function downloadRuntimePackage(
  root,
  cache,
  { fetcher = fetch, platform = process.platform, arch = process.arch } = {},
) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(root, "release-runtime.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(
      "此插件尚未包含有效的桌宠组件或下载清单，请安装完整桌宠插件包",
      { cause: error },
    );
  }
  await assertPackageVersion(root, manifest);
  const target = `${platform}-${arch}`;
  const asset = manifest.packages?.[target];
  if (!asset)
    throw new Error(
      `暂未提供 ${platform}/${arch} 桌宠组件，当前支持 Apple Silicon Mac 和 Windows x64`,
    );
  const version = manifest.version;
  const packageName = manifest.packageName || "dsh-girl";
  if (!["dsh-girl", "dsh-desk-buddy"].includes(packageName))
    throw new Error("桌宠下载清单包名无效");
  if (!/^[\w.-]+$/.test(version) || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error("桌宠下载清单无效");
  const url = new URL(asset.url);
  if (
    url.origin !== "https://github.com" ||
    url.pathname !==
      `/moutsea/dsh-desk-buddy/releases/download/v${version}/${packageName}-${version}-${target}.tgz` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("桌宠下载地址无效");
  const packages = join(cache, ".packages");
  const destination = join(packages, `${version}-${asset.sha256.slice(0, 16)}`);
  async function complete() {
    if (
      (await readFile(join(destination, ".complete"), "utf8")) !== asset.sha256
    )
      throw new Error("桌宠下载缓存不完整");
    await access(join(destination, "runtime.json"));
    await access(join(destination, "runtime/dsg.zip"));
  }
  try {
    await complete();
    return destination;
  } catch {}
  await mkdir(packages, { recursive: true });
  const staging = await mkdtemp(join(packages, ".download-"));
  try {
    const archive = join(staging, "plugin.tgz");
    try {
      await downloadVerifiedPackage(asset, archive, { fetcher });
    } catch (error) {
      throw new Error(
        `无法准备桌宠组件：${error.message}。请检查 GitHub 连接后在「dsh-desk-buddy」中重试，或安装 Release 完整插件包。`,
        { cause: error },
      );
    }
    const unpacked = join(staging, "package");
    await mkdir(unpacked);
    await extractTar({
      file: archive,
      cwd: unpacked,
      strip: 1,
      strict: true,
      filter(path, entry) {
        if (
          ![
            "package/package.json",
            "package/runtime.json",
            "package/runtime/dsg.zip",
          ].includes(path)
        )
          return false;
        if (entry.type !== "File" || entry.size > 512 * 1024 * 1024)
          throw new Error("桌宠组件包内容无效");
        return true;
      },
    });
    const pkg = JSON.parse(
      await readFile(join(unpacked, "package.json"), "utf8"),
    );
    const runtime = JSON.parse(
      await readFile(join(unpacked, "runtime.json"), "utf8"),
    );
    if (
      pkg.name !== packageName ||
      pkg.version !== version ||
      runtime.version !== version ||
      runtime.platform !== platform ||
      runtime.arch !== arch ||
      runtime.archive !== "runtime/dsg.zip"
    )
      throw new Error("下载的桌宠组件与当前系统或版本不匹配");
    await access(join(unpacked, "runtime/dsg.zip"));
    await writeFile(join(unpacked, ".complete"), asset.sha256);
    try {
      await rename(unpacked, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code))
        throw error;
      await complete();
    }
    return destination;
  } finally {
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
