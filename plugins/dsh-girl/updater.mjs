import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { c as createTar } from "tar";
import { downloadVerifiedPackage } from "./release-runtime.mjs";

const repository = "https://github.com/moutsea/dsh-desk-buddy";
const latestRelease =
  "https://api.github.com/repos/moutsea/dsh-desk-buddy/releases/latest";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function removalError(result) {
  // Host diagnostics can contain paths or credentials. Only translate known
  // pnpm error codes; never forward the raw package-manager output to the UI.
  const diagnostic = `${result?.packageResult?.output || ""}\n${result?.error?.diagnostic || ""}`;
  if (/ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY/.test(diagnostic))
    return "DSH 未能卸载旧插件：依赖锁文件不完整，请先修复 DSH 插件依赖";
  if (/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/.test(diagnostic))
    return "DSH 未能卸载旧插件：其他插件尚未满足发布时间要求，请稍后重试";
  return "DSH 未能卸载旧插件，更新已停止";
}

export function newerVersion(candidate, current) {
  if (!stableVersion.test(candidate) || !stableVersion.test(current))
    throw new Error("插件版本格式无效");
  const previous = current.split(".").map(BigInt);
  for (const [index, part] of candidate.split(".").map(BigInt).entries()) {
    if (part > previous[index]) return true;
    if (part < previous[index]) return false;
  }
  return false;
}

async function readReleaseText(fetcher, url, signal, limit = 1024 * 1024) {
  const response = await fetcher(url, {
    signal,
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub 暂时限制了请求，请稍后重试"
        : `无法读取 GitHub Release（HTTP ${response.status}）`,
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("更新信息大小超出限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function findUpdate(
  currentVersion,
  {
    fetcher = fetch,
    platform = process.platform,
    arch = process.arch,
    signal,
  } = {},
) {
  if (!["darwin-arm64", "win32-x64"].includes(`${platform}-${arch}`))
    throw new Error("手动更新当前支持 Apple Silicon Mac 和 Windows x64");
  const release = JSON.parse(
    await readReleaseText(fetcher, latestRelease, signal),
  );
  const version =
    typeof release.tag_name === "string" && release.tag_name.slice(1);
  if (
    !release.tag_name?.startsWith("v") ||
    !stableVersion.test(version) ||
    release.draft ||
    release.prerelease
  )
    throw new Error("GitHub Release 不是有效的正式版本");
  if (!newerVersion(version, currentVersion)) return null;
  const filename = `dsh-desk-buddy-${version}-${platform}-${arch}.tgz`;
  const base = `${repository}/releases/download/v${version}/`;
  const asset = release.assets?.find((entry) => entry.name === filename);
  const checksums = release.assets?.find(
    (entry) => entry.name === "SHA256SUMS.txt",
  );
  if (
    asset?.browser_download_url !== base + filename ||
    checksums?.browser_download_url !== base + "SHA256SUMS.txt"
  )
    throw new Error("新版本尚未提供当前系统的完整更新包和校验文件，请稍后重试");
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 512 * 1024 * 1024
  )
    throw new Error("更新包大小无效");
  const checksumText = await readReleaseText(
    fetcher,
    checksums.browser_download_url,
    signal,
    65536,
  );
  const matches = checksumText
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/))
    .filter((match) => match?.[2] === filename);
  if (matches.length !== 1) throw new Error("更新包缺少有效的 SHA-256 校验值");
  return {
    version,
    filename,
    url: asset.browser_download_url,
    sha256: matches[0][1],
    size: asset.size,
    releaseUrl: `${repository}/releases/tag/v${version}`,
  };
}

export class PluginUpdater {
  constructor({
    version,
    storage,
    service,
    hotReload = () => false,
    backup,
    trackJob = () => "",
    fetcher = fetch,
    platform = process.platform,
    arch = process.arch,
  }) {
    this.version = version;
    this.storage = storage;
    this.service = service;
    this.hotReload = hotReload;
    this.backup = backup;
    this.trackJob = trackJob;
    this.fetcher = fetcher;
    this.platform = platform;
    this.arch = arch;
    this.phase = "idle";
    this.error = "";
    this.downloaded = 0;
    this.abort = new AbortController();
  }
  unavailableReason() {
    if (typeof this.service()?.installBundle !== "function")
      return "当前 DSH 未提供插件更新接口，请升级 DSH Desktop 后使用";
    if (
      this.hotReload() &&
      (!this.backup ||
        typeof this.service()?.removeBundle !== "function" ||
        typeof this.service()?.listBundles !== "function")
    )
      return "当前 DSH 未提供完整的插件更新接口，请通过 DSH 插件管理升级";
    return "";
  }
  snapshot() {
    return {
      phase: this.phase,
      currentVersion: this.version,
      latestVersion: this.release?.version || "",
      releaseUrl: this.release?.releaseUrl || "",
      size: this.release?.size || 0,
      downloaded: this.downloaded,
      error: this.error,
      unavailable: this.unavailableReason(),
      jobUrl: this.jobUrl || "",
    };
  }
  begin(phase, run) {
    if (this.abort.signal.aborted) throw new Error("桌宠插件已停用");
    if (this.operation) throw new Error("正在处理更新，请稍候");
    if (this.phase === "restart-required")
      throw new Error("更新已安装，请重启 DSH 后使用");
    const unavailable = this.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    this.phase = phase;
    this.error = "";
    this.operation = Promise.resolve()
      .then(run)
      .catch((error) => {
        this.phase = "error";
        this.error = this.abort.signal.aborted
          ? "更新已取消"
          : `更新未完成：${error.message}`;
      })
      .finally(() => {
        this.operation = null;
      });
    return this.snapshot();
  }
  check() {
    return this.begin("checking", async () => {
      this.release = null;
      this.downloaded = 0;
      this.release = await findUpdate(this.version, {
        fetcher: this.fetcher,
        platform: this.platform,
        arch: this.arch,
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(20000),
        ]),
      });
      this.phase = this.release ? "available" : "current";
    });
  }
  install(version) {
    if (!this.release || version !== this.release.version)
      throw new Error("请先检查更新，再选择要安装的版本");
    const state = this.begin("downloading", async () => {
      const release = this.release;
      const directory = join(this.storage, "updates");
      await mkdir(directory, { recursive: true });
      const staging = await mkdtemp(join(directory, ".download-"));
      const archive = join(
        directory,
        `${release.sha256.slice(0, 16)}-${release.filename}`,
      );
      try {
        this.downloaded = 0;
        await downloadVerifiedPackage(release, join(staging, "plugin.tgz"), {
          fetcher: this.fetcher,
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(300000),
          ]),
          onProgress: (bytes) => {
            this.downloaded = bytes;
          },
        });
        this.abort.signal.throwIfAborted();
        await rename(join(staging, "plugin.tgz"), archive);
        this.phase = "installing";
        const service = this.service();
        const replace = this.hotReload();
        let rollback;
        if (replace) {
          const bundle = (await service.listBundles()).find(
            (entry) => entry.name === "dsh-desk-buddy",
          );
          if (!bundle?.removable || !bundle.installed)
            throw new Error("当前插件不能由 DSH 更新");
          rollback = await this.backup(directory);
          this.abort.signal.throwIfAborted();
        }
        this.requestId = randomUUID();
        const options = {
          enabled: true,
          saveExact: true,
          requestId: this.requestId,
        };
        let result;
        let removedOld = false;
        try {
          if (replace) {
            this.replacing = true;
            const removed = await service.removeBundle("dsh-desk-buddy");
            if (
              removed.error ||
              !["applied", "restart-required"].includes(removed.application)
            )
              throw new Error(removalError(removed));
            removedOld = true;
          }
          result = await service.installBundle(archive, options);
          this.validateResult(result, release.version);
        } catch (error) {
          if (this.replacing) {
            this.phase = "restoring";
            try {
              const installed = (await service.listBundles()).find(
                (entry) => entry.name === "dsh-desk-buddy" && entry.installed,
              );
              if (!removedOld && installed?.version === this.version) {
                // DSH deselects the bundle before pnpm removes its files. If
                // pnpm fails, the original package remains: re-enable it
                // without repeating the same failing package operation.
                const restored = await service.setBundleEnabled(
                  "dsh-desk-buddy",
                  true,
                );
                if (
                  restored.error ||
                  !["applied", "restart-required"].includes(
                    restored.application,
                  )
                )
                  throw new Error("无法恢复旧插件");
              } else {
                if (installed) {
                  const removed = await service.removeBundle("dsh-desk-buddy");
                  if (
                    removed.error ||
                    !["applied", "restart-required"].includes(
                      removed.application,
                    )
                  )
                    throw new Error("无法恢复旧插件");
                }
                this.validateResult(
                  await service.installBundle(rollback, {
                    ...options,
                    requestId: randomUUID(),
                  }),
                  this.version,
                );
              }
            } catch {
              throw new Error(
                `${error.message}；旧版自动恢复未完成。请在 DSH 插件管理中重新安装 GitHub 仓库地址；桌宠设置仍保留`,
              );
            }
            throw new Error(
              `${error.message}；已恢复旧版插件，请重启 DSH 后重试`,
            );
          }
          throw error;
        }
        this.phase = "restart-required";
      } finally {
        this.requestId = null;
        await rm(staging, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    });
    this.jobUrl = this.trackJob(this);
    return { ...state, jobUrl: this.jobUrl };
  }
  validateResult(result, version) {
    if (result.application === "cancelled") throw new Error("安装已取消");
    if (
      result.error ||
      !["applied", "restart-required"].includes(result.application)
    ) {
      const code = result.error?.code || result.packageResult?.kind;
      const reasons = {
        "already-installed": "当前 DSH 不允许原位更新，请通过 DSH 插件管理升级",
        "incompatible-version": "新插件与当前 DSH 不兼容，请先升级 DSH",
        "build-blocked": "DSH 要求确认依赖安装，请在 DSH 插件管理中处理",
        "disk-full": "磁盘空间不足",
        permission: "DSH 无法写入插件目录",
      };
      throw new Error(
        reasons[code] || "DSH 未完成插件安装，请查看 DSH 插件管理中的诊断",
      );
    }
    if (result.bundle !== "dsh-desk-buddy" || result.version !== version)
      throw new Error("DSH 返回的插件版本不匹配，请重启后检查插件版本");
  }
  async dispose() {
    if (this.replacing) return;
    this.abort.abort();
    if (this.requestId) await this.service()?.cancelInstall?.(this.requestId);
    await this.operation;
  }
}

export async function backupPlugin(root, directory) {
  let packageRoot = root;
  let manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!manifest.os) {
    packageRoot = join(root, "../..");
    manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
  }
  if (manifest.name !== "dsh-desk-buddy" || !Array.isArray(manifest.files))
    throw new Error("无法备份当前插件，更新已停止");
  const files = ["package.json"];
  for (const file of manifest.files) {
    if (
      !/^[\w./-]+$/.test(file) ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    )
      throw new Error("插件备份路径无效");
    try {
      await access(join(packageRoot, file));
      files.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const archive = join(
    directory,
    `rollback-${manifest.version}-${randomUUID()}.tgz`,
  );
  await createTar(
    { file: archive, cwd: packageRoot, prefix: "package", gzip: true },
    files,
  );
  return archive;
}
