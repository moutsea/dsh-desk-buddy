import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PluginUpdater } from "../plugins/dsh-girl/updater.mjs";

const directory = await mkdtemp(join(tmpdir(), "DSG update UI "));
const bytes = Buffer.from("complete plugin update fixture");
const checksum = createHash("sha256").update(bytes).digest("hex");
const filename = "dsh-desk-buddy-0.12.4-darwin-arm64.tgz";
const base =
  "https://github.com/moutsea/dsh-desk-buddy/releases/download/v0.12.4/";
let newer = false,
  corrupt = true,
  downloads = 0,
  installs = 0,
  releaseInstall;
const updater = new PluginUpdater({
  version: "0.12.3",
  storage: directory,
  platform: "darwin",
  arch: "arm64",
  service: () => ({
    installBundle: async (archive) => {
      assert.deepEqual(await readFile(archive), bytes);
      installs++;
      await new Promise((resolve) => {
        releaseInstall = resolve;
      });
      return {
        application: "restart-required",
        bundle: "dsh-desk-buddy",
        version: "0.12.4",
      };
    },
  }),
  fetcher: async (url) => {
    if (url.endsWith("/latest"))
      return Response.json({
        tag_name: newer ? "v0.12.4" : "v0.12.3",
        draft: false,
        prerelease: false,
        assets: [
          {
            name: filename,
            browser_download_url: base + filename,
            size: bytes.length,
          },
          {
            name: "SHA256SUMS.txt",
            browser_download_url: base + "SHA256SUMS.txt",
          },
        ],
      });
    if (url.endsWith("/SHA256SUMS.txt"))
      return new Response(`${checksum}  ${filename}`);
    downloads++;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    return new Response(corrupt ? "damaged" : bytes);
  },
});
const state = {
  phase: "running",
  connection: "connected",
  hostKind: "desktop",
  version: "0.12.3",
  autoStart: true,
  visible: true,
};
const snapshot = () => ({ ...state, update: updater.snapshot() });
const files = new Map([
  ["/dsh-girl/", ["index.html", "text/html"]],
  ["/dsh-girl/manager.js", ["manager.js", "text/javascript"]],
  ["/dsh-girl/manager.css", ["manager.css", "text/css"]],
  ["/dsh-girl/icon.png", ["icon.png", "image/png"]],
]);
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/dsh-girl/status.json") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(snapshot()));
    }
    if (req.url === "/dsh-girl/control") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { action, value } = JSON.parse(Buffer.concat(chunks).toString());
      if (action === "checkUpdate") updater.check();
      else if (action === "installUpdate") updater.install(value);
      else if (action === "hide") state.visible = false;
      else if (action === "show") state.visible = true;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(snapshot()));
    }
    const asset = files.get(req.url);
    if (!asset) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader("Content-Type", asset[1]);
    res.end(await readFile(join("plugins/dsh-girl/web", asset[0])));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const env = { ...process.env, DSG_TEST_UI_DIR: join(directory, "browser") };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: [
      resolve("tests/helpers/manager-shell.mjs"),
      `http://127.0.0.1:${server.address().port}/dsh-girl/`,
    ],
    env,
  });
  const page = await app.firstWindow();
  const check = page.getByRole("button", { name: "检查更新", exact: true });
  await expect(check).toBeEnabled();
  assert.equal(
    await page
      .locator(".brand img")
      .evaluate((node) => node.complete && node.naturalWidth),
    128,
  );
  await check.click();
  await expect(page.locator("#update-status")).toHaveText("当前已是最新版本");
  assert.equal(downloads, 0);
  newer = true;
  await check.click();
  await expect(page.locator("#update-status")).toHaveText("发现新版本 v0.12.4");
  const install = page.getByRole("button", {
    name: "下载并更新至 v0.12.4",
    exact: true,
  });
  await install.click();
  await expect(install).toBeDisabled();
  await expect(page.locator("#update-progress")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂时隐藏", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#update-error")).toContainText("校验失败");
  assert.equal(installs, 0);
  corrupt = false;
  await install.click();
  await expect(page.locator("#update-status")).toContainText("正在更新插件", {
    timeout: 10000,
  });
  await page.reload();
  await expect(check).toBeDisabled();
  await expect(install).toBeDisabled();
  releaseInstall();
  await expect(page.locator("#update-status")).toContainText(
    "已安装，请在任务完成后重启 DSH",
  );
  await expect(install).toBeHidden();
  await expect(check).toBeDisabled();
  assert.equal(installs, 1);
  assert.equal(downloads, 2);
  await page.setViewportSize({ width: 380, height: 730 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/plugin-update.png",
    fullPage: true,
  });
  console.log(
    "Manual update UI passed: current version, new release, progress, integrity failure, retry, refresh, restart prompt and logo.",
  );
} finally {
  releaseInstall?.();
  await app?.close();
  await updater.dispose();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
