import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { createCodexHost } from "../tests/helpers/codex-host.mjs";
const dsh = await createFixture(),
  codex = await createCodexHost();
const data = await mkdtemp(join(tmpdir(), "dsg-platforms-"));
dsh.sessions.set("same", {
  sessionId: "same",
  title: "平台区分测试",
  cwd: data,
  running: false,
  blank: false,
  updatedAt: Date.now(),
  events: [],
  projections: {
    asOfSeq: 10,
    values: {
      tokenUsage: {
        uncachedInputTokens: 100,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 20,
      },
    },
  },
});
dsh.event("same", "user/message", {
  content: [{ type: "text", text: "这是 DSH 的对话" }],
});
dsh.event("same", "assistant/message", {
  turn: 1,
  step: 0,
  message: {
    content: [{ type: "text", text: "DSH 保留浅色界面，继续处理项目任务。" }],
  },
});
const thread = codex.add("same");
thread.name = "平台区分测试";
thread.turns = [
  {
    id: "history",
    status: "completed",
    items: [
      {
        id: "u",
        type: "userMessage",
        content: [{ type: "text", text: "这是 Codex 的对话" }],
      },
      {
        id: "a",
        type: "agentMessage",
        text: "Codex 使用黑灰色界面，平台来源一眼可见。",
      },
    ],
  },
];
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    provider: "dsh",
    enabledProviders: ["dsh", "codex"],
    endpoint: dsh.endpoint,
    codexEndpoint: codex.endpoint,
    selectedId: "same",
    cwd: data,
    alwaysOnTop: false,
    chatSize: "medium",
    sounds: { enabled: false },
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const invoke = (action, payload) =>
    page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
  await expect
    .poll(
      async () =>
        Object.values((await state()).connections).filter(
          (row) => row.status === "connected",
        ).length,
    )
    .toBe(2);
  await expect.poll(async () => (await state()).sessions.length).toBe(2);
  await invoke("section", "chat");
  await invoke("select", "same");
  await expect(
    page.getByText("这是 DSH 的对话", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-metric="total"]')).toHaveText("220");
  const dshColor = await page
    .locator(".app-shell")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("DSH 草稿");
  await mkdir("artifacts", { recursive: true });
  await page
    .locator(".companion-surface")
    .screenshot({ path: "artifacts/platform-dsh.png" });
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await expect(page.locator(".session-card")).toHaveCount(2);
  await expect(
    page.locator('.session-card[data-provider="dsh"] .provider-badge'),
  ).toHaveText("DSH");
  await expect(
    page.locator('.session-card[data-provider="codex"] .provider-badge'),
  ).toHaveText("Codex");
  await page.locator('.session-card[data-provider="codex"]').click();
  await expect(
    page.getByText("这是 Codex 的对话", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("这是 DSH 的对话", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("");
  assert.equal(
    await page
      .locator(".app-shell")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(24, 25, 28)",
  );
  assert.notEqual(dshColor, "rgb(24, 25, 28)");
  codex.notify("thread/tokenUsage/updated", {
    threadId: "same",
    turnId: "history",
    tokenUsage: {
      total: { inputTokens: 500, cachedInputTokens: 250, outputTokens: 100 },
      last: { totalTokens: 600 },
      modelContextWindow: 10000,
    },
  });
  await expect(page.locator('[data-metric="total"]')).toHaveText("600");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("Codex 草稿");
  await page
    .locator(".companion-surface")
    .screenshot({ path: "artifacts/platform-codex.png" });
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "选择新会话平台" }),
  ).toBeVisible();
  await page
    .locator(".companion-surface")
    .screenshot({ path: "artifacts/platform-picker.png" });
  await page
    .getByRole("button", { name: "新建 Codex 会话", exact: false })
    .click();
  await expect
    .poll(async () => (await state()).selectedId)
    .not.toBe("codex:same");
  const codexId = (await state()).selectedId;
  assert(codexId.startsWith("codex:"));
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("发送到 Codex");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => codex.calls.filter((c) => c.method === "turn/start").length)
    .toBe(1);
  assert.equal(
    dsh.calls.filter((c) => c.method === "session.prompt").length,
    0,
  );
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page
    .getByRole("button", { name: "新建 DSH 会话", exact: false })
    .click();
  await expect.poll(async () => (await state()).selectedId).not.toBe(codexId);
  const dshId = (await state()).selectedId;
  assert(dsh.sessions.has(dshId));
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("发送到 DSH");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => dsh.calls.filter((c) => c.method === "session.prompt").length)
    .toBe(1);
  assert.equal(codex.calls.filter((c) => c.method === "turn/start").length, 1);
  await invoke("select", "same");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("DSH 草稿");
  await expect(page.locator('[data-metric="total"]')).toHaveText("220");
  await invoke("select", "codex:same");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("Codex 草稿");
  await expect(page.locator('[data-metric="total"]')).toHaveText("600");
  const turn = codex.start("same");
  dsh.sessions.get("same").running = true;
  dsh.event("same", "turn/start", { turn: 2 });
  await invoke("section", null);
  await expect(
    page.locator('.progress-card[data-provider="codex"]').first(),
  ).toBeAttached();
  await expect(
    page.locator('.progress-card[data-provider="dsh"]').first(),
  ).toBeAttached();
  await page.screenshot({ path: "artifacts/platform-bubbles.png" });
  codex.finish("same", turn);
  const codexBubble = page.locator(
    '.progress-card[data-session-id="codex:same"]',
  );
  await expect(codexBubble).toBeAttached();
  await expect(codexBubble).toContainText("已完成");
  await page
    .locator('.pet-progress-bubble[data-session-id="codex:same"]')
    .focus();
  await page.locator('.progress-dismiss[data-session-id="codex:same"]').focus();
  await page.keyboard.press("Enter");
  await expect(codexBubble).toHaveCount(0);
  assert.equal((await state()).surface.section, null);
  assert.equal(
    (await state()).sessions.find((row) => row.sessionId === "same").running,
    true,
  );
  const nextTurn = codex.start("same");
  await expect(codexBubble).toBeAttached();
  await invoke("dismissProgress", "codex:same");
  await expect(codexBubble).toHaveCount(0);
  // A failed same-provider replacement must retain dismissal, selection,
  // drafts, usage and the persisted working endpoint, including after restart.
  const beforeSwitch = await state();
  const savedBefore = JSON.parse(
    await readFile(join(data, "settings.json"), "utf8"),
  );
  const failedHost = await createCodexHost();
  failedHost.handler = (frame, socket) => {
    if (frame.method !== "initialize") return false;
    socket.send(
      JSON.stringify({
        id: frame.id,
        error: { code: -32603, message: "test handshake failure" },
      }),
    );
    return true;
  };
  try {
    await assert.rejects(
      invoke("connect", { provider: "codex", endpoint: failedHost.endpoint }),
      /test handshake failure/,
    );
    const afterSwitch = await state();
    assert.equal(afterSwitch.connections.codex.status, "connected");
    assert.equal(
      afterSwitch.connections.codex.epoch,
      beforeSwitch.connections.codex.epoch,
    );
    assert.equal(afterSwitch.selectedId, beforeSwitch.selectedId);
    assert.equal(afterSwitch.progressEntries["codex:same"].hidden, true);
    const savedAfter = JSON.parse(
      await readFile(join(data, "settings.json"), "utf8"),
    );
    for (const key of [
      "codexEndpoint",
      "endpoint",
      "provider",
      "enabledProviders",
      "selectedId",
    ])
      assert.deepEqual(savedAfter[key], savedBefore[key], key);
  } finally {
    await failedHost.close();
  }
  const epoch = (await state()).connections.codex.epoch;
  codex.disconnect();
  await expect
    .poll(async () => (await state()).connections.codex.epoch)
    .toBeGreaterThan(epoch);
  await expect
    .poll(async () => {
      const current = await state();
      return (
        current.connections.codex.status === "connected" &&
        current.sessions.find((row) => row.sessionId === "codex:same")
          ?.running === true
      );
    })
    .toBe(true);
  assert.equal(
    (await state()).progressEntries["codex:same"].hidden,
    true,
    "Codex reconnect must keep the same running task dismissed",
  );
  await expect(codexBubble).toHaveCount(0);
  assert.equal((await state()).connections.dsh.status, "connected");
  assert.equal((await state()).progressEntries.same.hidden, false);
  codex.finish("same", nextTurn);
  await expect
    .poll(async () => (await state()).progressEntries["codex:same"].active)
    .toBe(false);
  await expect(codexBubble).toHaveCount(0);
  codex.start("same");
  await expect(codexBubble).toBeAttached();
  await invoke("section", "chat");
  await invoke("select", "same");
  await invoke("disconnect", "codex");
  assert.equal((await state()).connections.dsh.status, "connected");
  assert.equal((await state()).selectedId, "same");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("DSH 草稿");
  await expect(page.locator('[data-metric="total"]')).toHaveText("220");
  assert.equal((await state()).activity.same.status, "thinking");
  await invoke("section", "settings");
  await expect(
    page.locator('.platform-connection[data-provider="dsh"]'),
  ).toContainText("已连接");
  await expect(
    page.locator('.platform-connection[data-provider="codex"]'),
  ).toContainText("未连接");
  await page.locator("#provider").selectOption("codex");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect
    .poll(async () => (await state()).connections.codex.status)
    .toBe("connected");
  assert.equal((await state()).connections.dsh.status, "connected");
  assert.equal((await state()).selectedId, "same");
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  app = await launchDesktop(env);
  const restored = await app.firstWindow();
  await expect
    .poll(
      async () =>
        Object.values(
          (await restored.evaluate(() => window.desktop.invoke("state")))
            .connections,
        ).filter((row) => row.status === "connected").length,
    )
    .toBe(2);
  console.log(
    "Multi-platform UI passed: simultaneous connection, same-ID isolation, badges/themes, provider choice, send routing, drafts/usage, bubbles, dismissal through automatic reconnect until the next task, disconnect isolation and restart.",
  );
} finally {
  await app?.close();
  await dsh.close();
  await codex.close();
  await rm(data, { recursive: true, force: true });
}
