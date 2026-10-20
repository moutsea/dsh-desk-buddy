import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-completion-"));
for (const [sessionId, title] of [
  ["front", "当前验收任务"],
  ["back", "后台验收任务"],
  ["other", "另一个后台任务"],
])
  fixture.sessions.set(sessionId, {
    sessionId,
    title,
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [
      {
        seq: 0,
        time: Date.now() - 60000,
        type: "turn/end",
        data: { reason: "completed" },
      },
    ],
  });
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    selectedId: "front",
    alwaysOnTop: false,
    idleExpressions: false,
    expression: "proud",
    petPosition: { x: 500, y: 300 },
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow({ timeout: 15000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const invoke = (action, payload) =>
    page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
  const start = (id) => {
    fixture.sessions.get(id).running = true;
    fixture.push("host", {
      type: "host/session-status",
      sessionId: id,
      running: true,
    });
    return fixture.event(id, "turn/start", {});
  };
  const finish = (id) => {
    fixture.sessions.get(id).running = false;
    const event = fixture.event(id, "turn/end", {
      reason: { kind: "completed" },
    });
    fixture.push("host", {
      type: "host/session-status",
      sessionId: id,
      running: false,
    });
    return event;
  };
  const notice = page.getByRole("status");
  const pet = page.locator(".pet-character");
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await expect(pet.locator('[data-expression="proud"]')).toBeVisible();
  await expect(page.locator(".pet-balance")).not.toBeVisible();
  await expect(notice).toHaveCount(0);
  assert.equal(
    (await state()).completions.length,
    0,
    "historical completion creates no reminder",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].blur(),
  );
  // On macOS, launching/blurring an app can animate the Dock and change the
  // work area. That legitimately relayouts this screen-height window. Take
  // the reaction baseline after those display changes have settled.
  await app.evaluate(
    ({ screen }) =>
      new Promise((resolve, reject) => {
        let quiet;
        const cleanup = () => {
          clearTimeout(quiet);
          clearTimeout(deadline);
          screen.removeListener("display-metrics-changed", changed);
        };
        const changed = () => {
          clearTimeout(quiet);
          quiet = setTimeout(() => {
            cleanup();
            resolve();
          }, 800);
        };
        const deadline = setTimeout(() => {
          cleanup();
          reject(new Error("Display work area did not stabilize"));
        }, 5000);
        screen.on("display-metrics-changed", changed);
        changed();
      }),
  );
  const original = await bounds();
  start("front");
  const completed = finish("front");
  await expect(notice).toHaveText("当前验收任务 完成啦！");
  await expect(page.locator(".pet-balance")).not.toBeVisible();
  await expect(page.locator(".companion-surface")).not.toBeVisible();
  await expect(pet.locator('[data-expression="celebrating"]')).toBeVisible();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFocused(),
    ),
    false,
  );
  assert.deepEqual(
    await bounds(),
    original,
    "reaction never moves the native window",
  );
  const transform = await page
    .locator(".pet-completion-action")
    .evaluate((node) => {
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
      const rest = getComputedStyle(node).transform;
      animation.currentTime = 240;
      const jump = getComputedStyle(node).transform;
      animation.play();
      return { rest, jump };
    });
  assert.notEqual(
    transform.jump,
    transform.rest,
    "completion changes the rendered pose position",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/completion-reminder.png",
    omitBackground: true,
  });
  const originalNotice = (await state()).completions[0];
  fixture.push("mux", {
    type: "session/event",
    sessionId: "front",
    event: completed,
  });
  start("front");
  await expect
    .poll(async () => (await state()).activity.front.status)
    .toBe("thinking");
  await expect(notice).toHaveText("当前验收任务 完成啦！");
  assert.deepEqual(
    (await state()).completions,
    [originalNotice],
    "replayed event does not restart or duplicate the reminder",
  );
  assert.equal((await state()).config.expression, "proud");
  await page.clock.install();
  await page.clock.fastForward(6500);
  await expect(notice).toHaveCount(0);
  await expect(pet.locator('[data-expression="proud"]')).toBeVisible();

  await page.clock.setSystemTime(Date.now());
  await invoke("connect", fixture.endpoint);
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await expect(notice).toHaveCount(0);
  start("back");
  finish("back");
  await expect(notice).toHaveText("后台验收任务 完成啦！");
  start("other");
  finish("other");
  await expect(notice).toHaveText("2 个任务完成啦！");
  assert.equal((await state()).selectedId, "front");
  assert.equal(
    (await state()).sessions.find((row) => row.sessionId === "front").running,
    true,
  );
  await invoke("animations", false);
  await expect(page.locator(".pet-completion-action")).not.toHaveClass(
    /is-celebrating/,
  );
  await expect(notice).toBeVisible();
  await invoke("animations", true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".pet-completion-action")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(notice).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".pet-completion-action")).toHaveCSS(
    "animation-name",
    "completion-bounce",
  );
  await page.clock.fastForward(6500);
  await expect(notice).toHaveCount(0);
  await expect(pet.locator('[data-expression="proud"]')).toBeVisible();
  assert.deepEqual(await bounds(), original);
  assert.deepEqual(errors, []);
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/session.prompt"),
    false,
  );
  console.log(
    "Completion UI passed: live current/background completion, non-hover action and task name, unchanged focus/position, manual pose restored, quick next turn, duplicate/reconnect suppression, grouped completions and reduced motion. No model calls.",
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
