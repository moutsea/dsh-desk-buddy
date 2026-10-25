import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

// Exercise the real component and CSS without opening a desktop window or
// connecting to a user's sessions. A fresh page resets React state per test.
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProgressBubbles } from "/src/ProgressBubbles.tsx";
import "/src/style.css";
const params = new URLSearchParams(location.search);
window.opened = [];
window.dismissed = [];
function App() {
  const [items, setItems] = useState(Array.from(
    { length: Number(params.get("count")) }, (_, i) => ({
      sessionId: "s" + i, title: "任务 " + i,
      text: "任务 " + i + " 的进度正文：正在检查编译输出与执行状态",
      label: "正在回复", status: "replying", provider: params.get("provider"),
    }),
  ));
  window.remove = id => setItems(items => items.filter(item => item.sessionId !== id));
  return React.createElement("div", {
    style: { position: "absolute", left: 100, top: 350 },
  }, React.createElement(ProgressBubbles, {
    items, headroom: 350, width: 300,
    onOpen: id => window.opened.push(id),
    onDismiss: id => { window.dismissed.push(id); window.remove(id); },
  }));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  plugins: [
    {
      name: "progress-pointer-fixture",
      resolveId(id) {
        if (id === "/__progress-fixture.js") return "\0progress-fixture";
      },
      load(id) {
        if (id === "\0progress-fixture") return fixture;
      },
      configureServer(server) {
        server.middlewares.use("/__progress.html", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__progress.html",
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/__progress-fixture.js"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const profile = await mkdtemp(join(tmpdir(), "dsg-progress-browser-"));
let child, browser, exited;
try {
  await server.listen();
  // Use Playwright's independent Chromium, never the user's Google Chrome.
  // DSG_TEST_BROWSER also accepts an installed chrome-headless-shell binary.
  const executable = process.env.DSG_TEST_BROWSER || chromium.executablePath();
  assert.ok(!executable.includes("/Applications/Google Chrome.app/"));
  child = spawn(
    executable,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  exited = once(child, "exit").catch(() => {});
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  let port;
  await expect
    .poll(
      async () => {
        if (launchError) throw launchError;
        assert.equal(
          child.exitCode,
          null,
          "Chromium exited before starting CDP",
        );
        port = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(
            () => "",
          )
        ).split("\n")[0];
        return !!port;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${server.httpServer.address().port}/__progress.html`;
  const withPage = async (count, provider, run) => {
    const page = await browser.contexts()[0].newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width: 800, height: 800 });
      await page.goto(`${base}?count=${count}&provider=${provider}`);
      await expect(page.locator(".progress-card")).toHaveCount(
        Math.min(5, count),
      );
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  };
  const positions = (page) =>
    page.locator(".progress-card").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.dataset.sessionId,
        x: node.offsetLeft,
        y: node.offsetTop,
      })),
    );
  const hitAt = (page, point) =>
    page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)?.closest("[data-session-id]");
      return {
        id: hit?.dataset.sessionId ?? null,
        close: !!hit?.matches(".progress-dismiss"),
      };
    }, point);

  await test("stationary clicks keep dismissing replacement cards instead of opening them", () =>
    withPage(12, "dsh", async (page) => {
      const stack = page.locator(".pet-progress-stack");
      const selection = await stack.getAttribute("data-selected-session");
      const close = await page
        .locator(".progress-dismiss")
        .first()
        .boundingBox();
      const point = {
        x: close.x + close.width / 2,
        y: close.y + close.height / 2,
      };
      await page.mouse.move(point.x, point.y);
      const dismissed = [];
      for (let i = 0; i < 3; i++) {
        await expect
          .poll(async () => (await hitAt(page, point)).close)
          .toBe(true);
        const { id } = await hitAt(page, point);
        assert.notEqual(id, selection);
        assert.ok(!dismissed.includes(id));
        const before = await positions(page);
        // No locator click and no mousemove: neither may repair stale hover state.
        await page.mouse.down();
        await page.mouse.up();
        dismissed.push(id);
        await expect(stack).toHaveAttribute(
          "data-total",
          String(12 - dismissed.length),
        );
        await expect(stack).toHaveAttribute("data-selected-session", selection);
        assert.deepEqual(await page.evaluate(() => window.opened), []);
        assert.deepEqual(
          await page.evaluate(() => window.dismissed),
          dismissed,
        );
        for (const slot of await positions(page)) {
          const previous = before.find((item) => item.id === slot.id);
          if (previous) assert.deepEqual(slot, previous);
        }
      }
    }));

  for (const provider of ["dsh", "codex"]) {
    await test(`${provider}: hovering the rear preview dims the foreground without moving targets`, () =>
      withPage(2, provider, async (page) => {
        const stack = page.locator(".pet-progress-stack");
        const selected = page.locator(".progress-card.is-active");
        const rear = page.locator(".progress-card").first();
        const selection = await stack.getAttribute("data-selected-session");
        const before = await positions(page);
        const box = await rear.boundingBox();
        const point = { x: box.x + 60, y: box.y + 10 };
        const hit = await hitAt(page, point);
        await page.mouse.move(point.x, point.y);
        await expect(rear).toHaveCSS("opacity", "1");
        await expect(rear.locator(".progress-preview")).toHaveCSS(
          "visibility",
          "visible",
        );
        await expect(selected).toHaveCSS("opacity", "0.1");
        await expect(selected.locator(".progress-preview")).toHaveCSS(
          "visibility",
          "hidden",
        );
        await expect(stack).toHaveAttribute("data-selected-session", selection);
        assert.deepEqual(await positions(page), before);
        assert.deepEqual(await hitAt(page, point), hit);
        await page.mouse.move(5, 5);
        await expect(selected).toHaveCSS("opacity", "1");
        await expect(selected.locator(".progress-preview")).toHaveCSS(
          "visibility",
          "visible",
        );
      }));
  }

  await test("a membership change while the pointer is in a gap does not revive the previous hover", () =>
    withPage(12, "dsh", async (page) => {
      const stack = page.locator(".pet-progress-stack");
      const rear = await page.locator(".progress-card").first().boundingBox();
      await page.mouse.move(rear.x + 60, rear.y + 10);
      const box = await stack.boundingBox();
      const gap = { x: box.x + 2, y: box.y + 2 };
      await page.mouse.move(gap.x, gap.y);
      assert.equal((await hitAt(page, gap)).id, null);
      await expect(page.locator(".progress-card.is-pointed")).toHaveCount(0);
      await page.evaluate(() => window.remove("s11"));
      await expect(stack).toHaveAttribute("data-total", "11");
      await expect(page.locator(".progress-card.is-pointed")).toHaveCount(0);
    }));

  await test("keyboard focus keeps its preview and close control while the pointer remains over another card", () =>
    withPage(2, "dsh", async (page) => {
      const rear = await page.locator(".progress-card").first().boundingBox();
      await page.mouse.move(rear.x + 60, rear.y + 10);
      const selected = page.locator(".pet-progress-bubble.is-active");
      await selected.focus();
      await expect(page.locator(".progress-card.is-active")).toHaveCSS(
        "opacity",
        "1",
      );
      await expect(page.locator(".progress-card:not(.is-active)")).toHaveCSS(
        "opacity",
        "0.1",
      );
      await page.keyboard.press("ArrowUp");
      await expect(selected).toBeFocused();
      const id = await selected.getAttribute("data-session-id");
      await page.keyboard.press("Tab");
      await expect(page.locator(".progress-dismiss.is-active")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator(".progress-card")).toHaveCount(1);
      assert.deepEqual(await page.evaluate(() => window.dismissed), [id]);
      assert.deepEqual(await page.evaluate(() => window.opened), []);
    }));
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null) {
    child.kill();
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
  await server.close();
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
