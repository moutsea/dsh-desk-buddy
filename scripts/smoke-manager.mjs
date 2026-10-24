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
let controlFailure = null;
let routesRemoved = false;
let managementRequests = 0;
const jobUrl = "/dsh-desk-buddy-update/11111111-1111-1111-1111-111111111111";
const updater = new PluginUpdater({
  version: "0.12.3",
  storage: directory,
  platform: "darwin",
  arch: "arm64",
  trackJob: () => jobUrl,
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
  ["/dsh-girl/launcher.js", ["launcher.js", "text/javascript"]],
]);
const server = createServer(async (req, res) => {
  try {
    if (
      ["/dsh-girl/status.json", "/dsh-girl/control", jobUrl].includes(req.url)
    ) {
      managementRequests++;
      if (routesRemoved) {
        res.writeHead(404);
        return res.end();
      }
    }
    if (req.url === jobUrl) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(updater.snapshot()));
    }
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        '<!doctype html><html><body><button id="user-menu" style="position:fixed;bottom:12px;left:12px;width:220px;height:60px">user-menu</button><script src="/dsh-girl/launcher.js"></script></body></html>',
      );
    }
    if (req.url === "/dsh-girl/status.json") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(snapshot()));
    }
    if (req.url === "/dsh-girl/control") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { action, value } = JSON.parse(Buffer.concat(chunks).toString());
      if (controlFailure) {
        res.writeHead(controlFailure.status);
        return res.end(controlFailure.body);
      }
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
  for (const [status, body, message] of [
    [404, "", "管理服务暂不可用"],
    [200, "", "状态为空或格式不正确"],
    [200, "null", "状态为空或格式不正确"],
    [400, JSON.stringify({ error: "测试操作被拒绝" }), "测试操作被拒绝"],
  ]) {
    controlFailure = { status, body };
    await page.getByRole("button", { name: "显示桌宠", exact: true }).click();
    await expect(page.locator("#error")).toContainText(message);
  }
  controlFailure = null;
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
  await expect(page.locator("#phase")).toHaveText("更新已安装，等待重启 DSH");
  for (const button of await page.locator("[data-action]").all())
    await expect(button).toBeDisabled();
  await expect(page.locator("#auto-start")).toBeDisabled();
  routesRemoved = true;
  const completedRequests = managementRequests;
  // The old host routes and the temporary job route can both disappear before
  // the user finishes their running tasks and restarts DSH.
  await page.waitForTimeout(2600);
  assert.equal(managementRequests, completedRequests);
  await expect(page.locator("#phase")).toHaveText("更新已安装，等待重启 DSH");
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#update-status")).toContainText(
    "已安装，请在任务完成后重启 DSH",
  );
  routesRemoved = false;
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
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const launcher = page.locator("deepseek-girl-manager button");
  await expect(launcher).toBeVisible();
  const initial = await launcher.boundingBox();
  const menu = await page.locator("#user-menu").boundingBox();
  assert.ok(
    initial.x > menu.x + menu.width,
    "default launcher avoids user menu",
  );
  await page.mouse.move(initial.x + 35, initial.y + 20);
  await page.mouse.down();
  await page.mouse.move(320, 180, { steps: 12 });
  await page.mouse.up();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  const dragged = await launcher.boundingBox();
  assert.ok(dragged.x < initial.x - 100);
  await page.reload();
  assert.deepEqual(
    await launcher.boundingBox(),
    dragged,
    "dragged position survives reload",
  );
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator("deepseek-girl-manager iframe");
  const management = page.frameLocator("deepseek-girl-manager iframe");
  await management.getByRole("heading", { name: "你的桌面小搭档" }).click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  await page.locator("#user-menu").evaluate((node) => {
    node.addEventListener("click", () => {
      node.dataset.clicked = "true";
    });
  });
  await page.locator("#user-menu").click();
  await expect(panel).toBeHidden();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#user-menu")).toHaveAttribute(
    "data-clicked",
    "true",
  );
  await expect(page.locator("#user-menu")).toBeFocused();
  await launcher.click();
  await expect(panel).toBeVisible();
  await management.getByRole("heading", { name: "你的桌面小搭档" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await launcher.click();
  await launcher.click();
  await expect(panel).toBeHidden();
  await launcher.click();
  await expect(panel).toBeVisible();
  const insideViewport = async () => {
    await expect
      .poll(async () => {
        const panel = await page
          .locator("deepseek-girl-manager iframe")
          .boundingBox();
        const viewport = page.viewportSize();
        return (
          panel.x >= 0 &&
          panel.y >= 0 &&
          panel.x + panel.width <= viewport.width &&
          panel.y + panel.height <= viewport.height
        );
      })
      .toBe(true);
  };
  const doesNotCoverLauncher = async () => {
    const bubble = await panel.boundingBox();
    const button = await launcher.boundingBox();
    assert.ok(
      bubble.y + bubble.height <= button.y ||
        button.y + button.height <= bubble.y,
      "the management panel leaves the launcher reachable",
    );
  };
  await insideViewport();
  await doesNotCoverLauncher();
  await page.setViewportSize({ width: 380, height: 500 });
  await insideViewport();
  await doesNotCoverLauncher();
  const resized = await launcher.boundingBox();
  assert.ok(
    resized.x >= 0 &&
      resized.x + resized.width <= 380 &&
      resized.y + resized.height <= 500,
  );
  await launcher.focus();
  await page.keyboard.press("Home");
  const reset = await launcher.boundingBox();
  assert.ok(
    Math.abs(reset.x + reset.width - 362) <= 1,
    JSON.stringify({
      reset,
      viewport: await page.evaluate(() => ({
        width: innerWidth,
        active: document.activeElement?.tagName,
        position: localStorage.getItem("dsh-desk-buddy-launcher-position"),
      })),
    }),
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal((await launcher.boundingBox()).x, reset.x - 10);
  await doesNotCoverLauncher();
  await page.screenshot({ path: "artifacts/plugin-launcher.png" });
  console.log(
    "Manual update UI and launcher passed: current version, progress, retry, empty/error responses, restart-required controls and expired routes, logo, user menu clearance, drag, click suppression, persistence, keyboard and viewport bounds.",
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
