import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";

// Capture the real Electron UI with isolated demonstration data, no account
// credentials or model calls. Run after npm run build.
const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-readme-"));
const output = "docs/images";
fixture.sessions.set("readme-demo", {
  sessionId: "readme-demo",
  title: "项目首页整理",
  running: false,
  blank: false,
  updatedAt: Date.now(),
  events: [],
  projections: {
    asOfSeq: 10,
    values: {
      tokenUsage: {
        uncachedInputTokens: 2000,
        cacheReadTokens: 16000,
        cacheWriteTokens: 2000,
        outputTokens: 4000,
      },
      contextPressure: {
        pressureTokens: 20000,
        projectedTokens: 24000,
        contextWindow: 64000,
      },
      sessionStats: {
        turns: 3,
        steps: 6,
        ttftMs: 1200,
        ttftSteps: 3,
        decodeMs: 50000,
        decodeTokens: 4000,
      },
    },
  },
});
fixture.event("readme-demo", "user/message", {
  role: "user",
  content: [
    { type: "text", text: "帮我整理项目首页，介绍功能、安装方法和使用方式。" },
  ],
});
fixture.event("readme-demo", "assistant/message", {
  turn: 0,
  step: 0,
  message: {
    content: [
      {
        type: "text",
        text: "已经整理好啦。\n\n- 把安装步骤放在前面，打开就能找到。\n- 精简功能介绍，补上桌宠、用量和声音设置的截图。\n- 将详细说明放进文档，方便继续查阅。\n\n你可以先预览一下，有想调整的地方随时告诉我。",
      },
    ],
  },
});
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    selectedId: "readme-demo",
    cwd: "/projects/desk-buddy",
    alwaysOnTop: false,
    idleExpressions: false,
    animations: false,
    expression: "happy",
    chatSize: "medium",
    petPosition: { x: 80, y: 400 },
  }),
);
await mkdir(output, { recursive: true });
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow();
  const invoke = (action, payload) =>
    page.evaluate(
      ([action, payload]) => window.desktop.invoke(action, payload),
      [action, payload],
    );
  await expect
    .poll(async () => (await invoke("state")).connection)
    .toBe("connected");
  await invoke("refresh");
  await invoke("section", "chat");
  await expect(page.locator('[data-metric="total"]')).toHaveText("24.0k");
  await page.evaluate(() => document.fonts.ready);
  await page
    .locator(".character-image.is-active image")
    .evaluateAll(async (nodes) => {
      await Promise.all(
        nodes.map(async (node) => {
          const image = new Image();
          image.src = node.href.baseVal;
          await image.decode();
        }),
      );
    });
  const capture = async (filename, selectors) => {
    const boxes = await Promise.all(
      selectors.map((selector) => page.locator(selector).boundingBox()),
    );
    assert.ok(boxes.every(Boolean), "all screenshot subjects are visible");
    const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 6);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 6);
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const right = Math.min(
      viewport.width,
      Math.max(...boxes.map((box) => box.x + box.width)) + 6,
    );
    const bottom = Math.min(
      viewport.height,
      Math.max(...boxes.map((box) => box.y + box.height)) + 6,
    );
    await page.screenshot({
      path: join(output, filename),
      omitBackground: true,
      clip: { x, y, width: right - x, height: bottom - y },
    });
  };
  await capture("conversation.png", [".companion-surface", ".pet-stage"]);
  await invoke("chatSize", "large");
  await page.locator(".session-usage summary").click();
  await expect(page.locator(".session-usage")).toHaveAttribute("open", "");
  await capture("session-usage.png", [".session-usage"]);
  await invoke("section", "settings");
  await page
    .locator(".sound-settings")
    .evaluate((node) =>
      node.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await expect(
    page.getByRole("button", { name: "试听当前声线" }),
  ).toBeEnabled();
  await capture("sound-settings.png", [
    ".sound-settings > .toggle-row",
    ".sound-voice-picker",
    "#sound-volume",
    ".sound-events-entry",
  ]);
  await page.getByRole("button", { name: /^互动声音设置/ }).click();
  await expect(
    page.getByRole("dialog", { name: "互动声音设置", exact: true }),
  ).toBeVisible();
  await capture("sound-events.png", [".sound-dialog-panel"]);
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/session.prompt"),
    false,
  );
  console.log(
    `Saved four README screenshots to ${output}; demonstration data only.`,
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
