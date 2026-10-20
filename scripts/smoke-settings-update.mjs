import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import electronPath from "electron";
import { DesktopManager } from "../plugins/dsh-girl/manager.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const directory = await mkdtemp(join(tmpdir(), "DSG settings update 中文 "));
const update = {
  phase: "idle",
  currentVersion: "0.12.4",
  latestVersion: "",
  error: "",
  jobUrl: "",
};
const requests = [];
let newer = false;
let fail = false;
const jobUrl = "/dsh-desk-buddy-update/11111111-1111-1111-1111-111111111111";
const server = createServer(async (req, res) => {
  requests.push(req.url);
  res.setHeader("Content-Type", "application/json");
  if (req.url === jobUrl) return res.end(JSON.stringify(update));
  if (req.url === "/dsh-girl/status.json")
    return res.end(JSON.stringify({ update }));
  if (req.url !== "/dsh-girl/control") {
    res.writeHead(404);
    return res.end("{}");
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (fail) {
    res.writeHead(503);
    return res.end("{}");
  }
  if (body.action === "checkUpdate") {
    update.phase = newer ? "available" : "current";
    update.latestVersion = newer ? "0.12.5" : "";
  } else if (body.action === "installUpdate") {
    assert.equal(body.value, "0.12.5");
    update.phase = "downloading";
    update.size = 1000;
    update.downloaded = 200;
    update.jobUrl = jobUrl;
  } else assert.fail("unexpected action");
  res.end(JSON.stringify({ update }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
await mkdir(join(directory, "settings"));
await writeFile(
  join(directory, "settings/settings.json"),
  JSON.stringify({ alwaysOnTop: false }),
);
const inspector = createServer();
inspector.listen(0, "127.0.0.1");
await once(inspector, "listening");
const inspectorPort = inspector.address().port;
await new Promise((resolve) => inspector.close(resolve));
const manager = new DesktopManager({
  endpoint: fixture.endpoint,
  displayEndpoint: `http://127.0.0.1:${server.address().port}`,
  storage: directory,
  root: directory,
  runtime: async () => ({
    executable: process.env.DSG_TEST_EXECUTABLE || electronPath,
    args: [
      ...(process.env.DSG_TEST_EXECUTABLE ? [] : ["."]),
      `--remote-debugging-port=${inspectorPort}`,
    ],
    version: "test",
  }),
});
let desktop;
try {
  await manager.init();
  desktop = await chromium.connectOverCDP(`http://127.0.0.1:${inspectorPort}`);
  const page = desktop.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.bringToFront();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktop.invoke("state").then((value) => value.connection),
      ),
    )
    .toBe("connected");
  await page.evaluate(() => window.desktop.invoke("section", "settings"));
  const card = page.getByRole("region", { name: "插件更新", exact: true });
  await expect(card.getByText("当前 v0.12.4", { exact: true })).toBeVisible();
  assert.equal(
    requests.filter((value) => value === "/dsh-girl/control").length,
    0,
  );
  const check = card.getByRole("button", { name: "检查更新", exact: true });
  await check.click();
  await expect(card.getByRole("status")).toHaveText("当前已是最新版本");
  fail = true;
  await check.click();
  await expect(card.getByRole("alert")).toContainText("插件已启用");
  fail = false;
  newer = true;
  await check.click();
  await expect(card.getByRole("status")).toHaveText("发现新版本 v0.12.5");
  const install = card.getByRole("button", {
    name: "下载并更新至 v0.12.5",
    exact: true,
  });
  await install.click();
  await expect(install).toBeDisabled();
  await expect(check).toBeDisabled();
  await expect(card.getByRole("progressbar")).toHaveAttribute("value", "200");
  update.phase = "error";
  update.error = "更新包校验失败";
  await expect(card.getByRole("alert")).toHaveText("更新包校验失败");
  await expect(install).toBeEnabled();
  update.error = "";
  await install.click();
  await expect(install).toBeDisabled();
  update.phase = "installing";
  await expect(card.getByRole("status")).toContainText("正在更新插件");
  update.phase = "restart-required";
  await expect(card.getByRole("status")).toContainText("重启 DSH");
  await expect(install).toHaveCount(0);
  await expect(check).toBeDisabled();
  assert.ok(
    requests.includes(jobUrl),
    "settings follows update job through plugin replacement",
  );
  assert.equal(desktop.contexts()[0].pages().length, 1);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/settings-plugin-update.png",
    omitBackground: true,
  });
  update.phase = "idle";
  update.latestVersion = "";
  update.unavailable = "当前 DSH 未提供插件更新接口";
  await expect(card.getByRole("status")).toHaveText(update.unavailable);
  await expect(check).toBeDisabled();
  console.log(
    "Settings update passed: separate management origin, no automatic check, current release, connection error, retry, download progress, replacement job, restart and unsupported host.",
  );
} finally {
  await desktop?.close();
  await manager.dispose();
  await fixture.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
