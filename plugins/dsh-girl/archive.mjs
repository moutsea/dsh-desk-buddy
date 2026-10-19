import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function powershell(script, variables = {}) {
  return exec(
    join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; " + script,
    ],
    {
      env: { ...process.env, ...variables },
      windowsHide: true,
      timeout: 180000,
    },
  );
}

export async function createArchive(source, archive) {
  if (process.platform === "darwin") {
    await exec(
      "/usr/bin/ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", source, archive],
      { timeout: 180000 },
    );
  } else if (process.platform === "win32") {
    await powershell(
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:DSG_ARCHIVE_SOURCE, $env:DSG_ARCHIVE_FILE, [System.IO.Compression.CompressionLevel]::Optimal, $true)",
      { DSG_ARCHIVE_SOURCE: source, DSG_ARCHIVE_FILE: archive },
    );
  } else {
    throw new Error("桌宠组件归档目前支持 macOS 和 Windows");
  }
}

export async function extractArchive(archive, destination) {
  if (process.platform === "darwin") {
    await exec("/usr/bin/ditto", ["-x", "-k", archive, destination], {
      timeout: 180000,
    });
  } else if (process.platform === "win32") {
    await powershell(
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:DSG_ARCHIVE_FILE, $env:DSG_ARCHIVE_DESTINATION)",
      { DSG_ARCHIVE_FILE: archive, DSG_ARCHIVE_DESTINATION: destination },
    );
  } else {
    throw new Error("桌宠组件安装目前支持 macOS 和 Windows");
  }
}
