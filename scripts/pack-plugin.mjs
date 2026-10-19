import { rolldown } from "rolldown";
import { extractFile } from "@electron/asar";
import { readFile, writeFile, mkdir, cp, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileHash } from "../plugins/dsh-girl/runtime.mjs";
import { createArchive } from "../plugins/dsh-girl/archive.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!["darwin", "win32"].includes(process.platform))
  throw new Error(
    "完整插件包支持 macOS 和 Windows；请在目标系统构建对应架构的组件",
  );
const windows = process.platform === "win32";
const app = join(
  root,
  "release",
  ...(windows
    ? [process.arch === "x64" ? "win-unpacked" : `win-${process.arch}-unpacked`]
    : [process.arch === "arm64" ? "mac-arm64" : "mac", "DeepSeek Girl.app"]),
);
const packaged = JSON.parse(
  extractFile(
    join(app, windows ? "resources/app.asar" : "Contents/Resources/app.asar"),
    "package.json",
  ).toString("utf8"),
);
if (packaged.version !== pkg.version || packaged.name !== pkg.name)
  throw new Error("桌宠组件版本不匹配，请先执行 npm run pack");
const source = join(root, "plugins/dsh-girl");
const output = join(
  root,
  "release",
  `dsh-girl-plugin-${pkg.version}-${process.platform}-${process.arch}`,
);
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "runtime"), { recursive: true });
const bundle = await rolldown({
  input: join(source, "index.mjs"),
  platform: "node",
  external: /^node:/,
});
await bundle.write({ file: join(output, "index.mjs"), format: "es" });
await bundle.close();
for (const file of ["web", "cordis.patch.yml", "README.md"])
  await cp(join(source, file), join(output, file), { recursive: true });
const pluginPackage = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
pluginPackage.version = pkg.version;
pluginPackage.os = [process.platform];
pluginPackage.cpu = [process.arch];
await writeFile(
  join(output, "package.json"),
  JSON.stringify(pluginPackage, null, 2),
);
const archive = join(output, "runtime/dsg.zip");
await createArchive(app, archive);
await writeFile(
  join(output, "runtime.json"),
  JSON.stringify(
    {
      version: pkg.version,
      platform: process.platform,
      arch: process.arch,
      archive: "runtime/dsg.zip",
      sha256: await fileHash(archive),
      executable: windows
        ? `${process.arch === "x64" ? "win-unpacked" : `win-${process.arch}-unpacked`}/DeepSeek Girl.exe`
        : "DeepSeek Girl.app/Contents/MacOS/DeepSeek Girl",
    },
    null,
    2,
  ),
);
if (!process.env.npm_execpath)
  throw new Error("请使用 npm run pack:plugin 构建插件包");
const packed = await exec(
  process.execPath,
  [
    process.env.npm_execpath,
    "pack",
    "--json",
    "--pack-destination",
    join(root, "release"),
  ],
  { cwd: output, maxBuffer: 1024 * 1024 },
);
const [result] = JSON.parse(packed.stdout);
const packagePath = join(
  root,
  "release",
  `dsh-girl-${pkg.version}-${process.platform}-${process.arch}.tgz`,
);
await rename(join(root, "release", result.filename), packagePath);
console.log(
  JSON.stringify(
    {
      plugin: output,
      package: packagePath,
      bytes: result.size,
    },
    null,
    2,
  ),
);
