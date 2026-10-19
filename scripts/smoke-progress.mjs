import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-progress-"));
for (const [sessionId, title] of [
  ["front", "当前任务"],
  ["back", "后台检查项目"],
])
  fixture.sessions.set(sessionId, {
    sessionId,
    title,
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    selectedId: "front",
    alwaysOnTop: false,
    petPosition: { x: 500, y: 250 },
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  let page = await app.firstWindow({ timeout: 15000 });
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const invoke = (action, payload) =>
    page.evaluate(
      ([name, value]) => window.desktop.invoke(name, value),
      [action, payload],
    );
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
  const bubble = () =>
    page.getByRole("button", { name: "查看进度：后台检查项目" });
  await expect.poll(async () => (await state()).connection).toBe("connected");
  assert.equal((await state()).config.progressBubbles, true);
  await expect(bubble()).toHaveCount(0);
  const original = await bounds();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].blur(),
  );
  fixture.sessions.get("back").running = true;
  fixture.event("back", "turn/start", { turn: 1 });
  await expect(bubble()).toBeVisible();
  await expect(bubble()).toContainText("正在思考");
  assert.equal((await state()).selectedId, "front");
  assert.deepEqual(await bounds(), original);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFocused(),
    ),
    false,
  );
  fixture.event("back", "tool/call", {
    name: "bash",
    callId: "check",
    arguments: JSON.stringify({ command: "git status --short\nnpm test" }),
  });
  await expect(bubble()).toContainText("git status --short npm test");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/progress-bubble.png",
    omitBackground: true,
  });
  await bubble().click();
  await expect(page.locator(".companion-surface")).toBeVisible();
  await expect.poll(async () => (await state()).selectedId).toBe("back");
  await expect(page.locator(".tool-copy code")).toHaveText(
    "git status --short\nnpm test",
  );
  await page.locator(".tool-message summary").click();
  await expect(page.locator(".tool-message pre")).toContainText('"command"');
  await page.screenshot({ path: "artifacts/tool-command.png" });
  await expect(page.locator(".welcome h1")).toHaveCount(0);
  fixture.event("back", "tool/result", {
    message: { content: [{ type: "tool-result", toolCallId: "check" }] },
  });
  await invoke("section", null);
  await expect(bubble()).toBeVisible();
  await expect(bubble()).not.toContainText("npm test");
  fixture.push("mux", {
    type: "session/assistant-stream",
    sessionId: "back",
    frame: { type: "start", attemptId: "preview", revision: 1 },
  });
  fixture.push("mux", {
    type: "session/assistant-stream",
    sessionId: "back",
    frame: {
      type: "chunk",
      attemptId: "preview",
      revision: 2,
      chunk: { type: "text-delta", text: "正在检查测试结果，接下来整理修改。" },
    },
  });
  await expect(bubble()).toContainText("正在检查测试结果");
  await bubble().click();
  await expect(page.locator(".message.assistant .message-label")).toContainText(
    "dsh-desk-buddy",
  );
  await expect(page.locator(".app-shell")).not.toContainText(
    /DeepSeek Girl|DeepSeek 娘/,
  );
  await invoke("section", "settings");
  const toggle = page.getByRole("switch", {
    name: "执行进度气泡",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await invoke("section", null);
  await expect(bubble()).toHaveCount(0);
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(data, "settings.json"), "utf8"))
          .progressBubbles,
    )
    .toBe(false);
  await app.close();
  app = await launchDesktop(env);
  page = await app.firstWindow({ timeout: 15000 });
  await expect.poll(async () => (await state()).connection).toBe("connected");
  assert.equal((await state()).config.progressBubbles, false);
  await expect(bubble()).toHaveCount(0);
  await invoke("section", "settings");
  await page.getByRole("switch", { name: "执行进度气泡", exact: true }).click();
  await invoke("section", null);
  await expect(bubble()).toBeVisible();
  fixture.sessions.get("back").running = false;
  fixture.event("back", "turn/end", { reason: { kind: "completed" } });
  await expect(bubble()).toHaveCount(0);
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/session.prompt"),
    false,
  );
  console.log(
    "Progress bubble passed: background tools and streaming, click-to-chat, visible commands, product name, no focus/position changes, persisted toggle and completion cleanup. No model calls.",
  );
} finally {
  await app?.close();
  await fixture.close();
  await rm(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
