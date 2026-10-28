import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { checkDesktopUsage } from "./desktop-usage.mjs";
import { checkLiveUpdates } from "./live-updates.mjs";
import { holdRequests, holdResponse } from "../tests/helpers/held-response.mjs";

const fixture = await createFixture({ historyPageSize: 2 });
const data = await mkdtemp(join(tmpdir(), "dsg-usage-"));
const tokens = {
  uncachedInputTokens: 1000,
  cacheReadTokens: 8000,
  cacheWriteTokens: 1000,
  outputTokens: 2000,
};
const zero = Object.fromEntries(Object.keys(tokens).map((key) => [key, 0]));
const values = {
  tokenUsage: tokens,
  contextPressure: {
    projectedTokens: 2500,
    pressureTokens: 2000,
    contextWindow: 10000,
  },
  sessionStats: {
    turns: 3,
    steps: 6,
    ttftMs: 600,
    ttftSteps: 3,
    decodeMs: 2000,
    decodeTokens: 120,
  },
};
for (const [id, title] of [
  ["a", "用量测试"],
  ["b", "未上报会话"],
]) {
  fixture.sessions.set(id, {
    sessionId: id,
    title,
    updatedAt: Date.now(),
    running: false,
    blank: false,
    events: [],
    ...(id === "a"
      ? {
          projections: { asOfSeq: 10, values },
          // Persisted list checkpoints cannot be compared with live session seq.
          listProjections: {
            kind: "cached",
            asOfSeq: 1000,
            values: {
              ...values,
              tokenUsage: { ...tokens, outputTokens: 110000 },
            },
          },
        }
      : {}),
  });
}
for (let turn = 0; turn < 3; turn++) {
  fixture.event("a", "user/message", {
    role: "user",
    content: [{ type: "text", text: `第 ${turn + 1} 轮检查` }],
  });
  fixture.event("a", "assistant/message", {
    turn,
    step: 0,
    message: {
      content: [{ type: "text", text: "已完成检查，可以继续下一个任务。" }],
    },
  });
}
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    selectedId: "a",
    alwaysOnTop: false,
    idleExpressions: false,
    animations: false,
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
  page.on("pageerror", (error) => errors.push(error.message));
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await page.evaluate(() => window.desktop.invoke("section", "chat"));
  const usage = page.locator(".session-usage");
  const total = usage.locator('[data-metric="total"]');
  const cache = usage.locator('[data-metric="cache"]');
  const context = usage.locator('[data-metric="context"]');
  const value = (name) =>
    usage
      .locator("dl > div")
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator("dd");
  await expect(total).toHaveText("12.0k");
  await expect(cache).toHaveText("80.0%");
  await expect(context).toHaveText("≈25.0%");
  await expect.poll(async () => (await state()).events.length).toBe(2);
  await usage.locator("summary").click();
  await expect(value("输入 Token")).toHaveText("10,000");
  await expect(value("输出 Token")).toHaveText("2,000");
  await expect(value("缓存写入")).toHaveText("1,000");
  await expect(value("平均生成速度")).toHaveText("60.0 token/s");
  await expect(value("平均首字耗时")).toHaveText("0.20 s");
  await usage.locator("summary").click();
  // Loading retained history must not sum or replace the full-session totals.
  for (const length of [4, 6]) {
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await expect.poll(async () => (await state()).events.length).toBe(length);
    await expect(total).toHaveText("12.0k");
  }
  await expect(
    page.getByRole("button", { name: "加载更早的消息" }),
  ).toHaveCount(0);

  const select = async (title) => {
    await page.getByRole("button", { name: "切换会话", exact: true }).click();
    await expect(usage).toBeHidden();
    await page.locator(".session-card").filter({ hasText: title }).click();
  };
  await select("未上报会话");
  await expect(total).toHaveText("—");
  await expect(cache).toHaveText("—");
  await expect(context).toHaveText("—");
  await expect(usage).not.toHaveAttribute("open", "");
  const update = (id, key, value, seq) => {
    const row = fixture.sessions.get(id);
    row.projections = {
      asOfSeq: seq,
      values: { ...row.projections?.values, [key]: value },
    };
    fixture.push("mux", {
      type: "session/projection",
      sessionId: id,
      key,
      value,
      seq,
    });
  };
  update("b", "tokenUsage", zero, 1);
  await expect(total).toHaveText("0");
  await expect(cache).toHaveText("—");
  await select("用量测试");
  await expect(total).toHaveText("12.0k");

  const updatedTokens = {
    ...tokens,
    cacheReadTokens: 18000,
    outputTokens: 4000,
  };
  update("a", "tokenUsage", updatedTokens, 20);
  update(
    "a",
    "contextPressure",
    { ...values.contextPressure, projectedTokens: 5000 },
    20,
  );
  update(
    "a",
    "sessionStats",
    { ...values.sessionStats, decodeTokens: 400, steps: 7 },
    20,
  );
  await expect(total).toHaveText("24.0k");
  await expect(cache).toHaveText("90.0%");
  await expect(context).toHaveText("≈50.0%");
  // Duplicate and stale updates must not inflate or roll back cumulative usage.
  fixture.push("mux", {
    type: "session/projection",
    sessionId: "a",
    key: "tokenUsage",
    value: updatedTokens,
    seq: 20,
  });
  fixture.push("mux", {
    type: "session/projection",
    sessionId: "a",
    key: "tokenUsage",
    value: zero,
    seq: 19,
  });
  update(
    "a",
    "sessionStats",
    { ...values.sessionStats, decodeTokens: 400, steps: 8 },
    21,
  );
  await usage.locator("summary").click();
  await expect(value("对话轮次 / 步数")).toHaveText("3 / 8");
  await expect(total).toHaveText("24.0k");
  await expect(value("平均生成速度")).toHaveText("200.0 token/s");
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await expect(total).toHaveText("24.0k");
  update("b", "tokenUsage", tokens, 2);
  await expect
    .poll(
      async () =>
        (await state()).sessions.find((s) => s.sessionId === "b").projections
          .asOfSeq,
    )
    .toBe(2);
  await expect(total).toHaveText("24.0k");

  await mkdir("artifacts", { recursive: true });
  for (const size of ["small", "medium", "large"]) {
    await page.evaluate(
      (size) => window.desktop.invoke("chatSize", size),
      size,
    );
    const textbox = page.getByRole("textbox", { name: "消息" });
    await textbox.fill("指标展开时也能继续输入");
    await expect(textbox).toBeInViewport();
    const layout = await page.evaluate(() => {
      const usage = document.querySelector(".session-usage");
      const messages = document.querySelector(".messages");
      const composer = document.querySelector(".composer-area");
      const panel = document.querySelector(".app-shell");
      return {
        overflow: usage.scrollWidth > usage.clientWidth,
        messageHeight: messages.clientHeight,
        composerBottom: composer.getBoundingClientRect().bottom,
        panelBottom: panel.getBoundingClientRect().bottom,
      };
    });
    assert.equal(
      layout.overflow,
      false,
      `${size}: usage must fit horizontally`,
    );
    assert.ok(
      layout.messageHeight >= 40,
      `${size}: keep messages readable (${layout.messageHeight}px)`,
    );
    assert.ok(
      layout.composerBottom <= layout.panelBottom,
      `${size}: composer stays inside panel`,
    );
    await page
      .locator(".companion-surface")
      .screenshot({ path: `artifacts/usage-${size}-expanded.png` });
    await usage.locator("summary").click();
    await page
      .locator(".companion-surface")
      .screenshot({ path: `artifacts/usage-${size}.png` });
    await usage.locator("summary").click();
  }
  // Context without an estimate is labeled as the latest measured request.
  update(
    "a",
    "contextPressure",
    { pressureTokens: 12000, contextWindow: 10000 },
    22,
  );
  await expect(context).toHaveText("120.0%");
  await expect(value("最近上下文")).toHaveText("12,000 / 10,000 Token");
  await select("未上报会话");
  await expect(total).toHaveText("12.0k");
  await expect(usage).not.toHaveAttribute("open", "");

  // Same-cut capability changes may race with pagination. Accept the old
  // message page, but never let its snapshot undo a later refresh.
  const racing = {
    ...fixture.sessions.get("a"),
    sessionId: "overlap",
    title: "乱序快照",
    projections: { asOfSeq: 10, values: {} },
    listProjections: { kind: "cached", asOfSeq: 1000, values: {} },
  };
  fixture.sessions.set("overlap", racing);
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await select("乱序快照");
  await expect(total).toHaveText("—");
  await expect.poll(async () => (await state()).events.length).toBe(2);
  for (const [nextValues, text, count] of [
    [{ tokenUsage: tokens }, "12.0k", 4],
    [{}, "—", 6],
  ]) {
    const held = await holdResponse(app, "/api/session.history");
    const request =
      count === 4
        ? { sessionId: "overlap", requestId: "usage-pagination" }
        : undefined;
    const older = page
      .evaluate((request) => window.desktop.invoke("older", request), request)
      .catch((error) => ({ error: error.message }));
    await held.wait();
    racing.projections = { asOfSeq: 10, values: nextValues };
    await page.evaluate(() => window.desktop.invoke("refresh"));
    await expect(total).toHaveText(text);
    await held.release();
    const receipt = await older;
    if (request) {
      assert.equal(receipt.sessionId, request.sessionId);
      assert.ok(Number.isSafeInteger(receipt.eventsRevision));
      assert.deepEqual((await state()).historyPage, request);
    } else assert.equal(receipt, undefined);
    await expect(total).toHaveText(text);
    await expect.poll(async () => (await state()).events.length).toBe(count);
  }
  const historyReads = fixture.calls.filter(
    (call) =>
      call.path === "/api/session.history" && call.payload.sessionId === "a",
  ).length;
  assert.ok(historyReads > 0);
  assert.equal(
    await page.evaluate(() =>
      window.desktop.invoke("older", {
        sessionId: "a",
        requestId: "stale-session-pagination",
      }),
    ),
    undefined,
  );
  assert.equal(
    fixture.calls.filter(
      (call) =>
        call.path === "/api/session.history" && call.payload.sessionId === "a",
    ).length,
    historyReads,
  );
  await expect(
    page.getByRole("button", { name: "加载更早的消息" }),
  ).toHaveCount(0);
  // Request C answers at an earlier cut, then A advances the cut. B is newer
  // than A at that same cut, so C's request ticket must not block B's changes.
  const tokenValues = (outputTokens) => ({
    tokenUsage: { ...tokens, outputTokens },
  });
  for (const [cut, firstValues, firstText, finalValues, finalText] of [
    [11, tokenValues(14000), "24.0k", tokenValues(26000), "36.0k"],
    [13, tokenValues(26000), "36.0k", {}, "—"],
    [15, {}, "—", tokenValues(14000), "24.0k"],
  ]) {
    const held = await holdRequests(app, "/api/session.history", 2);
    const refresh = () =>
      page
        .evaluate(() => window.desktop.invoke("refresh"))
        .catch((error) => ({ error: error.message }));
    const first = refresh();
    await held.wait(1);
    const second = refresh();
    await held.wait(2);
    racing.projections = { asOfSeq: cut, values: tokenValues(2000) };
    assert.equal(await refresh(), undefined);
    await expect(total).toHaveText("12.0k");
    racing.projections = { asOfSeq: cut + 1, values: firstValues };
    await held.release(0);
    assert.equal(await first, undefined);
    await expect(total).toHaveText(firstText);
    racing.projections = { asOfSeq: cut + 1, values: finalValues };
    await held.release(1);
    assert.equal(await second, undefined);
    await expect(total).toHaveText(finalText);
  }
  assert.deepEqual(errors, []);
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/session.prompt"),
    false,
  );
  console.log(
    "Session usage passed: cumulative buckets, cache rate, live/duplicate/stale updates, session switching, paginated history, out-of-order snapshots across advancing cuts, same-cut corrections/removals/restorations, missing/zero data and all three dialog sizes. No model calls.",
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
await checkDesktopUsage();
await checkLiveUpdates();
