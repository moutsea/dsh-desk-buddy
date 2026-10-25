import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { EXPRESSIONS } from "../shared/expressions.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../tests/fixture.mjs";
const fixture = await createFixture(),
  data = await mkdtemp(join(tmpdir(), "dsh-girl-ui-"));
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    cwd: "/tmp/dsh-girl-test-project",
    alwaysOnTop: false,
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, panel;
try {
  desktop = await launchDesktop(env);
  for (let attempt = 0; attempt < 100; attempt++) {
    panel = desktop.windows().find((page) => page.url().includes("view=pet"));
    if (panel) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(panel, "single desktop window exists");
  // This suite tests the explicit animation toggle. System accessibility
  // preferences are covered independently by smoke-motion.
  await panel.emulateMedia({ reducedMotion: "no-preference" });
  const errors = [];
  panel.on("pageerror", (error) => errors.push(error.message));
  panel.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const pet = panel.locator(".pet-character");
  await expect
    .poll(
      async () =>
        (await panel.evaluate(() => window.desktop.invoke("state"))).connection,
    )
    .toBe("connected");
  assert.equal(desktop.windows().length, 1);
  await expect(panel.locator(".companion-surface")).not.toBeVisible();
  await expect(
    panel.getByRole("button", { name: "对话", exact: true }),
  ).not.toBeVisible();
  await expect(panel.locator(".pet-balance")).not.toBeVisible();
  await mkdir("artifacts", { recursive: true });
  await panel.screenshot({
    path: "artifacts/desktop-rest.png",
    omitBackground: true,
  });
  const anchor = async () => {
    const surface = (await panel.evaluate(() => window.desktop.invoke("state")))
      .surface;
    const bounds = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    return { x: bounds.x + surface.pet.x, y: bounds.y + surface.pet.y };
  };
  const originalAnchor = await anchor();
  const openSection = async (name) => {
    await pet.hover();
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(panel.locator(".companion-surface")).toBeVisible();
    await expect(panel.locator(".surface-title strong")).toHaveText(name);
    assert.deepEqual(
      await anchor(),
      originalAnchor,
      "expanding preserves DSG position",
    );
    assert.equal(desktop.windows().length, 1);
  };
  await pet.hover();
  await expect(panel.locator(".pet-balance")).toBeVisible();
  await expect(panel.locator(".pet-pricing-period")).toBeVisible();
  await expect(panel.locator(".pet-pricing-period")).toHaveText(/^(峰时|谷时)/);
  assert.equal(await panel.locator(".pet-orb:visible").count(), 3);
  await panel.screenshot({
    path: "artifacts/desktop-hover.png",
    omitBackground: true,
  });
  // The mouse can cross from DSG to a bubble without hiding the controls.
  await openSection("对话");
  await expect(panel.locator(".connection-strip")).toContainText(
    "DSH · 已连接",
  );
  await panel
    .locator(".welcome-mascot .character-image.is-active image")
    .evaluate(async (node) => {
      const image = new Image();
      image.src = node.href.baseVal;
      await image.decode();
    });
  const welcomeBounds = await panel.locator(".welcome-mascot").boundingBox();
  const messageBounds = await panel.locator(".messages").boundingBox();
  assert.ok(
    welcomeBounds.y >= messageBounds.y &&
      welcomeBounds.y + welcomeBounds.height <=
        messageBounds.y + messageBounds.height,
    "welcome character is fully visible",
  );
  await mkdir("artifacts", { recursive: true });
  await panel.screenshot({ path: "artifacts/welcome.png" });
  assert.equal(await panel.locator(".tabs").count(), 0);
  assert.equal(
    await panel.getByRole("button", { name: "任务", exact: true }).count(),
    0,
  );
  await panel.getByRole("button", { name: "新建会话", exact: true }).click();
  await panel.getByText("测试项目任务", { exact: true }).waitFor();
  await panel.getByRole("textbox", { name: "消息" }).fill("检查测试项目");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await panel.getByText("正在检查项目…", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "允许一次", exact: true }).waitFor();
  await pet.locator('[data-expression="confused"]').waitFor();
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  const sessionPicker = panel.getByRole("region", { name: "会话列表" });
  await sessionPicker
    .locator(".session-card")
    .filter({ hasText: "测试项目任务" })
    .filter({ hasText: "等待你回应" })
    .waitFor();
  await panel.keyboard.press("Escape");
  await expect(sessionPicker).toHaveCount(0);
  // The removed list can leave focus on body; Escape must still close the content.
  await panel.keyboard.press("Escape");
  await expect(panel.locator(".companion-surface")).not.toBeVisible();
  await panel.evaluate(() => window.desktop.invoke("section", "chat"));
  await panel
    .getByRole("textbox", { name: "消息" })
    .fill("收起后仍然保留的草稿");
  await panel.keyboard.press("Escape");
  await expect(panel.locator(".companion-surface")).not.toBeVisible();
  await panel.evaluate(() => window.desktop.invoke("section", "chat"));
  await expect(panel.getByRole("textbox", { name: "消息" })).toHaveValue(
    "收起后仍然保留的草稿",
  );
  await panel.getByRole("textbox", { name: "消息" }).fill("");
  // Verify reconnect restores an unanswered request, rather than losing it.
  fixture.dropStreams();
  await expect(panel.locator(".connection-strip")).toContainText(
    "DSH · 重新连接中",
  );
  await expect(panel.locator(".connection-strip")).toContainText(
    "DSH · 已连接",
  );
  await panel.getByRole("button", { name: "允许一次", exact: true }).click();
  await panel.getByText("下一步做什么？", { exact: true }).waitFor();
  await panel.getByRole("radio", { name: "继续检查" }).check();
  await panel.getByRole("button", { name: "提交回答", exact: true }).click();
  await panel
    .getByText("检查完成，项目已经准备好。", { exact: true })
    .waitFor();
  assert.equal(
    await panel.getByText("正在检查项目…", { exact: true }).count(),
    0,
  );
  await panel.getByRole("textbox", { name: "消息" }).fill("触发失败");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "拒绝此消息" }).waitFor();
  assert.equal(
    await panel.getByRole("textbox", { name: "消息" }).inputValue(),
    "触发失败",
  );
  await panel.getByRole("textbox", { name: "消息" }).fill("停止测试");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await panel
    .getByRole("button", { name: "停止当前轮次", exact: true })
    .waitFor();
  await panel
    .getByRole("button", { name: "停止当前轮次", exact: true })
    .click();
  await panel
    .locator(".task-status")
    .getByText("当前轮次已停止", { exact: true })
    .waitFor();
  const sessionId = [...fixture.sessions.keys()][0];
  const live = (type, data) => fixture.event(sessionId, type, data);
  const avatar = (expression) =>
    panel.locator(`.conversation-avatar [data-expression="${expression}"]`);
  const taskRunning = (running) => {
    fixture.sessions.get(sessionId).running = running;
    fixture.push("host", { type: "host/session-status", sessionId, running });
  };
  taskRunning(true);
  live("turn/start", { turn: 4 });
  live("tool/call", { callId: "study", name: "read" });
  await pet.locator('[data-expression="learning"]').waitFor();
  await avatar("learning").waitFor();
  // A polling/host running update must preserve the specific tool phase.
  taskRunning(true);
  await avatar("learning").waitFor();
  await panel.screenshot({ path: "artifacts/task-learning.png" });
  await panel.screenshot({
    path: "artifacts/pet-learning.png",
    omitBackground: true,
  });
  live("tool/result", {
    message: {
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: "study",
          isError: true,
          content: [{ type: "text", text: "read failed" }],
        },
      ],
    },
  });
  live("tool/call", { callId: "repair", name: "bash" });
  await pet.locator('[data-expression="surprised"]').waitFor();
  await avatar("surprised").waitFor();
  await panel.screenshot({
    path: "artifacts/pet-shocked.png",
    omitBackground: true,
  });
  await pet.locator('[data-expression="working"]').waitFor({ timeout: 6500 });
  await avatar("working").waitFor();
  live("tool/result", {
    message: {
      role: "user",
      content: [{ type: "tool-result", toolCallId: "repair", content: [] }],
    },
  });
  live("assistant/chunk", {
    turn: 4,
    step: 0,
    chunk: { type: "text-delta", text: "已经修复。" },
  });
  await expect(panel.locator(".conversation-mood")).toHaveText("正在和你说话");
  taskRunning(false);
  live("turn/end", {
    turn: 4,
    reason: { kind: "error", error: { message: "测试任务失败" } },
  });
  await avatar("surprised").waitFor();
  await avatar("sad").waitFor({ timeout: 6500 });
  // Starting a new turn clears the old error immediately.
  taskRunning(true);
  live("turn/start", { turn: 5 });
  await avatar("thinking").waitFor();
  taskRunning(false);
  live("turn/end", { turn: 5, reason: { kind: "completed" } });
  await avatar("celebrating").waitFor();
  await pet.locator('[data-expression="celebrating"]').waitFor();
  await panel.screenshot({ path: "artifacts/task-celebrating.png" });
  await panel.screenshot({
    path: "artifacts/pet-celebrating.png",
    omitBackground: true,
  });
  await avatar("happy").waitFor({ timeout: 8500 });
  // An off-screen session also drives the desktop pet, independently of this chat's avatar.
  fixture.sessions.set("background", {
    ...fixture.sessions.get(sessionId),
    sessionId: "background",
    events: [],
    running: true,
    projections: { asOfSeq: -1, values: { title: { title: "后台验收任务" } } },
  });
  fixture.push("host", { type: "host/session-added", sessionId: "background" });
  await expect
    .poll(
      async () =>
        (await panel.evaluate(() => window.desktop.invoke("state"))).sessions
          .length,
    )
    .toBe(2);
  fixture.event("background", "turn/start", { turn: 1 });
  fixture.sessions.get("background").running = false;
  fixture.event("background", "turn/end", {
    turn: 1,
    reason: { kind: "completed" },
  });
  await pet.locator('[data-expression="celebrating"]').waitFor();
  assert.equal(
    await avatar("celebrating").count(),
    0,
    "current chat stays independent of background celebration",
  );
  await openSection("设置");
  await panel.getByText("12.34", { exact: false }).first().waitFor();
  await panel.getByRole("switch", { name: "窗口置顶" }).click();
  await openSection("对话");
  await panel.getByRole("textbox", { name: "消息" }).fill("留在当前会话的草稿");
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  await panel.screenshot({ path: "artifacts/sessions.png" });
  await sessionPicker
    .locator(".session-card")
    .filter({ hasText: "后台验收任务" })
    .click();
  await expect(sessionPicker).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "消息" })).toHaveValue("");
  await panel.getByRole("textbox", { name: "消息" }).fill("另一段会话的草稿");
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  await sessionPicker
    .locator(".session-card")
    .filter({ hasText: "测试项目任务" })
    .click();
  await expect(panel.getByRole("textbox", { name: "消息" })).toHaveValue(
    "留在当前会话的草稿",
  );
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  await sessionPicker
    .getByRole("button", { name: "关闭会话列表", exact: true })
    .click();
  await expect(panel.getByRole("textbox", { name: "消息" })).toHaveValue(
    "留在当前会话的草稿",
  );
  await panel.getByRole("textbox", { name: "消息" }).fill("");
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  await sessionPicker
    .getByRole("button", { name: "新建会话", exact: true })
    .click();
  await expect(sessionPicker).toHaveCount(0);
  assert.equal(
    (await panel.evaluate(() => window.desktop.invoke("state"))).sessions
      .length,
    3,
  );
  await expect(panel.getByRole("textbox", { name: "消息" })).toHaveValue("");
  await panel.getByRole("button", { name: "切换会话", exact: true }).click();
  await sessionPicker
    .locator(".session-card")
    .filter({ hasText: "测试项目任务" })
    .first()
    .click();
  await panel.getByRole("textbox", { name: "消息" }).waitFor();
  await panel
    .getByText("检查完成，项目已经准备好。", { exact: true })
    .waitFor();
  await mkdir("artifacts", { recursive: true });
  await panel.screenshot({ path: "artifacts/chat.png" });
  await openSection("设置");
  await panel.screenshot({ path: "artifacts/settings.png" });
  await openSection("表情");
  assert.equal(await panel.getByRole("radio").count(), EXPRESSIONS.length + 1);
  const motionToggle = panel.getByRole("switch", { name: "动态动作" });
  await motionToggle.click();
  await expect(pet.locator(".motion-sprite.ready")).toHaveAttribute(
    "data-playing",
    "false",
  );
  await motionToggle.click();
  await expect(pet.locator(".motion-sprite.ready")).toHaveAttribute(
    "data-playing",
    "true",
  );
  for (const item of EXPRESSIONS) {
    const choice = panel.getByRole("radio", { name: item.label, exact: true });
    await choice.click();
    await expect(choice).toHaveAttribute("aria-checked", "true");
    await pet.locator(`[data-expression="${item.id}"]`).waitFor();
  }
  await panel.getByRole("switch", { name: "空闲随机表情" }).click();
  await expect(
    panel.getByRole("switch", { name: "空闲随机表情" }),
  ).toHaveAttribute("aria-checked", "false");
  await panel
    .getByRole("radio", { name: "自动跟随会话", exact: false })
    .click();
  await pet.locator('[data-expression="idle"]').waitFor();
  await panel.locator(".page-content").evaluate((node) => {
    node.scrollTop = 0;
  });
  await panel.screenshot({ path: "artifacts/expressions.png" });
  await expect
    .poll(() =>
      panel
        .locator('.expression-preview .motion-sprite[data-playing="true"]')
        .count(),
    )
    .toBeGreaterThan(0);
  assert.ok(
    (await panel
      .locator('.expression-preview .motion-sprite[data-playing="true"]')
      .count()) < EXPRESSIONS.length,
    "offscreen previews pause",
  );
  await panel.screenshot({ path: "artifacts/pet.png", omitBackground: true });
  await panel.mouse.move(15, 15);
  await expect(panel.locator(".pet-balance")).not.toBeVisible();
  await panel.clock.install();
  await panel.getByRole("switch", { name: "空闲随机表情" }).click();
  await expect(
    panel.getByRole("switch", { name: "空闲随机表情" }),
  ).toHaveAttribute("aria-checked", "true");
  await panel.clock.fastForward(65000);
  await pet.locator('[data-expression="bored"]').waitFor();
  await panel.clock.fastForward(60000);
  await pet.locator('[data-expression="sleepy"]').waitFor();
  await panel.clock.fastForward(125000);
  await pet.locator('[data-expression="sleeping"]').waitFor();
  fixture.sessions.get(sessionId).running = true;
  fixture.push("host", {
    type: "host/session-status",
    sessionId,
    running: true,
  });
  await pet.locator('[data-expression="thinking"]').waitFor();
  fixture.sessions.get(sessionId).running = false;
  fixture.push("host", {
    type: "host/session-status",
    sessionId,
    running: false,
  });
  await panel.getByRole("switch", { name: "空闲随机表情" }).click();
  await pet.locator('[data-expression="idle"]').waitFor();
  await pet.dispatchEvent("mouseover");
  await panel.clock.fastForward(8100);
  await pet.locator('[data-expression="shy"]').waitFor();
  for (let count = 0; count < 5; count++) await pet.dispatchEvent("click");
  await pet.locator('[data-expression="angry"]').waitFor();
  // Petting changes the expression while the attached content stays in place.
  await expect(panel.locator(".companion-surface")).toBeVisible();
  assert.equal(desktop.windows().length, 1);
  await panel.getByRole("button", { name: "收起内容", exact: true }).click();
  await expect(panel.locator(".companion-surface")).not.toBeVisible();
  assert.deepEqual(
    await anchor(),
    originalAnchor,
    "collapsing preserves DSG position",
  );
  assert.equal(
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    ),
    1,
  );
  // Time changes update the badge while the same hover controls stay open.
  await panel.evaluate(
    (endpoint) => window.desktop.invoke("connect", endpoint),
    fixture.endpoint,
  );
  await expect
    .poll(
      async () =>
        (await panel.evaluate(() => window.desktop.invoke("state"))).connection,
    )
    .toBe("connected");
  await pet.hover();
  await pet.focus();
  await expect(pet).toBeFocused();
  await expect(panel.locator(".pet-hover-controls")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  for (const [time, label, countdown] of [
    ["2026-10-19T08:59:59+08:00", "谷时", "00:00:01"],
    ["2026-10-19T09:00:00+08:00", "峰时", "03:00:00"],
    ["2026-10-19T12:00:00+08:00", "谷时", "02:00:00"],
    ["2026-10-19T14:00:00+08:00", "峰时", "04:00:00"],
    ["2026-10-19T18:00:00+08:00", "谷时", "15:00:00"],
    ["2026-10-01T10:00:00+08:00", "谷时", "6天 23:00:00"],
    ["2026-02-13T18:00:00+08:00", "谷时", "10天 15:00:00"],
    ["2027-10-01T10:00:00+08:00", "峰时·估算", "约02:00:00"],
  ]) {
    await panel.clock.setFixedTime(new Date(time));
    await panel.clock.fastForward(600);
    await expect(panel.locator(".pet-pricing-label")).toHaveText(label);
    await expect(panel.locator(".pet-pricing-countdown")).toHaveText(countdown);
    await expect(panel.locator(".pet-balance")).toBeVisible();
    await expect(panel.locator(".pet-balance")).toHaveAccessibleName(
      new RegExp(`DeepSeek 余额 .*当前${label}`),
    );
    await expect(panel.locator(".pet-balance")).toHaveAttribute(
      "title",
      /北京时间.*\n峰时：/,
    );
    assert.ok(
      await panel.locator(".pet-balance").evaluate((node) => {
        const pill = node.getBoundingClientRect();
        return [...node.children].every((child) => {
          const bounds = child.getBoundingClientRect();
          return bounds.left >= pill.left && bounds.right <= pill.right;
        });
      }),
      "balance and time period fit inside the hover pill",
    );
    if (time.includes("T09:00:") || time.includes("T12:00:"))
      await panel.screenshot({
        path: `artifacts/desktop-hover-${label === "峰时" ? "peak" : "off-peak"}.png`,
        omitBackground: true,
      });
  }
  await panel.clock.setSystemTime(new Date("2026-10-19T11:59:58+08:00"));
  await panel.clock.pauseAt(new Date("2026-10-19T11:59:58.750+08:00"));
  await expect(panel.locator(".pet-pricing-countdown")).toHaveText("00:00:02");
  await panel.clock.runFor(1000);
  await expect(panel.locator(".pet-pricing-countdown")).toHaveText("00:00:01");
  await panel.clock.runFor(1000);
  await expect(panel.locator(".pet-pricing-label")).toHaveText("谷时");
  await expect(panel.locator(".pet-pricing-countdown")).toHaveText("02:00:00");
  await panel.locator(".pet-balance").click();
  await expect(panel.locator(".surface-title strong")).toHaveText("设置");
  await panel.locator(".surface-title").hover();
  await panel.clock.fastForward(600);
  await expect(panel.locator(".pet-pricing-period")).not.toBeVisible();
  assert.deepEqual(errors, []);
  await panel.evaluate(() => window.desktop.invoke("expression", "love"));
  await desktop.close();
  desktop = null;
  const saved = JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
  assert.equal(saved.expression, "love");
  assert.equal(saved.idleExpressions, false);
  assert.equal(saved.animations, true);
  console.log(
    "Electron UI passed: unified conversation navigation, session switching/creation and retained drafts, pending approvals, live reactions, all 19 expressions, idle timing, live peak/off-peak hover badges, settings persistence and one transparent window with hover controls and stable position. Screenshots: artifacts/",
  );
} catch (error) {
  if (panel) {
    await panel
      .screenshot({ path: "artifacts/ui-failure.png" })
      .catch(() => {});
    const state = await panel
      .evaluate(() => window.desktop.invoke("state"))
      .catch(() => null);
    if (state)
      console.error(
        "UI failure state:",
        JSON.stringify({
          surface: state.surface,
          config: state.config,
          connection: state.connection,
        }),
      );
  }
  throw error;
} finally {
  await desktop?.close();
  await fixture.close();
  await rm(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
