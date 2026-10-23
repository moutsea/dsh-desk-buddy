import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createCodexHost } from "../tests/helpers/codex-host.mjs";
import { createFixture } from "../tests/fixture.mjs";
const host = await createCodexHost();
const dsh = await createFixture();
host.add();
host.add("background");
const data = await mkdtemp(join(tmpdir(), "dsg-codex-ui-"));
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    provider: "codex",
    codexEndpoint: host.endpoint,
    selectedId: "thread-1",
    cwd: data,
    alwaysOnTop: false,
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
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await page.evaluate(() => window.desktop.invoke("section", "chat"));
  await expect(
    page.getByText("Codex 联调", { exact: true }).first(),
  ).toBeVisible();
  assert.equal(await page.locator(".pet-balance").count(), 0);
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("桌宠发送测试");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await state()).sessions.find((s) => s.sessionId === "codex:thread-1")
          .running,
    )
    .toBe(true);
  const turn = host.sessions.get("thread-1").turns.at(-1);
  host.item("thread-1", turn, {
    id: "assistant",
    type: "agentMessage",
    text: "",
  });
  host.notify("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: turn.id,
    itemId: "assistant",
    delta: "正在检查 Codex 集成",
  });
  await expect(
    page.getByText("正在检查 Codex 集成", { exact: true }),
  ).toBeVisible();
  host.item(
    "thread-1",
    turn,
    { id: "assistant", type: "agentMessage", text: "正在检查 Codex 集成" },
    true,
  );
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  host.notify("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: turn.id,
    tokenUsage: {
      total: {
        inputTokens: 1000,
        cachedInputTokens: 600,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1200,
      },
      last: { totalTokens: 1200 },
      modelContextWindow: 10000,
    },
  });
  await expect(page.locator('[data-metric="total"]')).toHaveText("1.2k");
  await expect(page.locator('[data-metric="cache"]')).toHaveText("60.0%");
  host.notify(
    "item/commandExecution/requestApproval",
    {
      threadId: "thread-1",
      turnId: turn.id,
      itemId: "command",
      command: "pwd",
      cwd: data,
      reason: "检查当前目录",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
    101,
  );
  await expect(
    page.getByRole("button", { name: "本会话允许", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "本会话允许", exact: true }).click();
  await expect.poll(() => host.responses.length).toBe(1);
  assert.deepEqual(host.responses[0], {
    id: 101,
    result: { decision: "acceptForSession" },
  });
  host.notify(
    "item/tool/requestUserInput",
    {
      threadId: "thread-1",
      turnId: turn.id,
      questions: [
        {
          id: "choice",
          question: "下一步做什么？",
          options: [{ label: "继续测试" }],
        },
      ],
    },
    102,
  );
  await page.getByText("继续测试", { exact: true }).click();
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect.poll(() => host.responses.length).toBe(2);
  assert.deepEqual(host.responses[1].result, {
    answers: { choice: { answers: ["继续测试"] } },
  });
  const background = host.start("background");
  host.item("background", background, {
    id: "shell",
    type: "commandExecution",
    command: "npm test",
    status: "inProgress",
  });
  await expect
    .poll(async () => (await state()).activity["codex:background"]?.status)
    .toBe("working");
  await page.getByRole("button", { name: "停止当前轮次", exact: true }).click();
  await expect
    .poll(async () => (await state()).activity["codex:thread-1"]?.status)
    .toBe("cancelled");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("草稿保留");
  host.disconnect();
  await expect
    .poll(() => host.calls.filter((c) => c.method === "initialize").length)
    .toBe(2);
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("草稿保留");
  assert.equal(host.calls.filter((c) => c.method === "turn/start").length, 1);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/codex-ui.png" });
  // Desktop history is readable, refreshed and visibly separate from live control.
  const external = host.add("desktop-history");
  external.status = { type: "notLoaded" };
  external.name = "桌面端历史";
  external.turns = [
    {
      id: "external-turn",
      status: "inProgress",
      items: [
        {
          id: "external-message",
          type: "agentMessage",
          text: "桌面窗口保存的内容",
        },
      ],
    },
  ];
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await expect(
    page.locator(".session-card").filter({ hasText: "桌面端历史" }),
  ).toContainText("仅查看 · 外部会话");
  await page.getByRole("button").filter({ hasText: "桌面端历史" }).click();
  await expect(
    page.getByText("桌面窗口保存的内容", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "停止当前轮次", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("原窗口的运行状态未接入", { exact: true }),
  ).toBeVisible();
  const completedBefore = (await state()).completions.length;
  external.turns[0].items[0].text = "桌面窗口保存后的新内容";
  external.turns[0].status = "completed";
  await expect(
    page.getByText("桌面窗口保存后的新内容", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  assert.equal((await state()).completions.length, completedBefore);
  assert(
    !host.calls.some(
      (c) =>
        c.method === "thread/resume" && c.params.threadId === "desktop-history",
    ),
  );
  await page
    .locator(".companion-surface")
    .screenshot({ path: "artifacts/codex-history.png" });

  // Delay the opening read so notifications / the automatic external poll win
  // the race. Exercise the same IPC and rendering path as opening a real chat.
  const savedTurn = (id, text, status = "completed") => ({
    id,
    status,
    items: [{ id: `${id}-message`, type: "agentMessage", text }],
  });
  const ordered = host.add("history-order");
  ordered.turns = [savedTurn("old", "读取前的旧回复")];
  const refreshed = host.add("history-refresh");
  refreshed.status = { type: "notLoaded" };
  refreshed.turns = [savedTurn("external", "未完成的旧回复", "inProgress")];
  await page.evaluate(() => window.desktop.invoke("refresh"));
  const deferredSelection = async (thread, check) => {
    let release;
    host.handler = (frame, socket) => {
      if (
        frame.method !== "thread/turns/list" ||
        frame.params.threadId !== thread.id ||
        release
      )
        return false;
      const result = {
        data: structuredClone(thread.turns).reverse(),
        nextCursor: null,
      };
      let released = false;
      release = () => {
        if (!released) socket.send(JSON.stringify({ id: frame.id, result }));
        released = true;
      };
      return true;
    };
    const selecting = page.evaluate(
      (id) => window.desktop.invoke("select", `codex:${id}`),
      thread.id,
    );
    // Keep failure cleanup from turning a closed test window into an unhandled rejection.
    selecting.catch(() => {});
    try {
      await expect.poll(() => !!release).toBe(true);
      await check(async () => {
        release();
        await selecting;
      });
    } finally {
      release?.();
      host.handler = null;
      await selecting.catch(() => {});
    }
  };
  await deferredSelection(ordered, async (finishRead) => {
    const fresh = host.start(ordered.id);
    host.item(
      ordered.id,
      fresh,
      savedTurn("new", "读取期间的新回复").items[0],
      true,
    );
    await expect(
      page.getByText("读取期间的新回复", { exact: true }),
    ).toBeVisible();
    await finishRead();
    await expect(
      page.locator(".message.assistant .message-content"),
    ).toHaveText(["读取前的旧回复", "读取期间的新回复"]);
    host.finish(ordered.id, fresh);
  });
  await deferredSelection(refreshed, async (finishRead) => {
    refreshed.turns = [savedTurn("external", "自动刷新后的完整回复")];
    await expect(
      page.getByText("自动刷新后的完整回复", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await finishRead();
    // Check the committed main-process snapshot as well, so the assertion cannot
    // pass merely because the renderer has not received the late response yet.
    const events = (await state()).events;
    assert.deepEqual(
      events
        .filter((event) => event.type === "assistant/message")
        .map((event) => event.data.message.content[0].text),
      ["自动刷新后的完整回复"],
    );
    assert.equal(events.at(-1).data.reason.kind, "completed");
    await expect(
      page.locator(".message.assistant .message-content"),
    ).toHaveText(["自动刷新后的完整回复"]);
  });
  // Reopen an external chat after more than one page of unseen work. Cover
  // both an exhausted old history and an old cursor that still has pages.
  for (const initial of [1, 25]) {
    const gapped = host.add(`history-gap-${initial}`);
    gapped.status = { type: "notLoaded" };
    const replies = (count) =>
      Array.from({ length: count }, (_, i) =>
        savedTurn(`gap-${i + 1}`, `分页回复 ${i + 1}`),
      );
    gapped.turns = replies(initial);
    host.handler = (frame, socket) => {
      if (
        frame.method !== "thread/turns/list" ||
        frame.params.threadId !== gapped.id
      )
        return false;
      const ordered = [...gapped.turns].reverse();
      const offset = frame.params.cursor
        ? ordered.findIndex((turn) => turn.id === frame.params.cursor) + 1
        : 0;
      const data = ordered.slice(offset, offset + frame.params.limit);
      const nextCursor =
        offset + data.length < ordered.length ? data.at(-1).id : null;
      socket.send(
        JSON.stringify({ id: frame.id, result: { data, nextCursor } }),
      );
      return true;
    };
    try {
      await page.evaluate(() => window.desktop.invoke("refresh"));
      await page.evaluate(
        (id) => window.desktop.invoke("select", `codex:${id}`),
        gapped.id,
      );
      const messages = page.locator(".message.assistant .message-content");
      await expect(messages).toHaveCount(Math.min(initial, 20));
      await page.evaluate(() => window.desktop.invoke("section", "settings"));
      gapped.turns = replies(initial + 30);
      await page.evaluate(() => window.desktop.invoke("refresh"));
      await page.evaluate(() => window.desktop.invoke("section", "chat"));
      await expect(messages).toHaveText(
        gapped.turns
          .slice(Math.max(0, initial - 20))
          .map((turn) => turn.items[0].text),
      );
      if (initial > 20) {
        await page
          .getByRole("button", { name: "加载更早的消息", exact: true })
          .click();
      }
      await expect(messages).toHaveText(
        gapped.turns.map((turn) => turn.items[0].text),
      );
      await expect(page.locator(".load-older")).toHaveCount(0);
      assert.equal((await state()).hasMore, false);
    } finally {
      host.handler = null;
    }
  }
  // Reverts update an open shared chat immediately, without replaying task
  // completion. A delayed opening read must not restore the withdrawn reply.
  const reverted = host.add("history-revert");
  const revertTurns = () => [
    savedTurn("retained", "撤回后保留的回复"),
    savedTurn("withdrawn", "应当撤回的回复"),
  ];
  reverted.turns = revertTurns();
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await page.evaluate(
    (id) => window.desktop.invoke("select", `codex:${id}`),
    reverted.id,
  );
  const revertedMessages = page.locator(".message.assistant .message-content");
  await expect(revertedMessages).toHaveText([
    "撤回后保留的回复",
    "应当撤回的回复",
  ]);
  const completionsBeforeRevert = (await state()).completions.length;
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("撤回后仍保留的草稿");
  // A failed replacement is visible and automatically retried for shared
  // chats too. A slow retry must not create another read every polling tick.
  let replacementReads = 0,
    finishReplacement;
  host.handler = (frame, socket) => {
    if (
      frame.method !== "thread/turns/list" ||
      frame.params.threadId !== reverted.id
    )
      return false;
    replacementReads++;
    if (replacementReads === 1) {
      socket.send(
        JSON.stringify({
          id: frame.id,
          error: { code: -32000, message: "temporary replacement failure" },
        }),
      );
    } else if (replacementReads === 2) {
      finishReplacement = () =>
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: { data: [...reverted.turns].reverse(), nextCursor: null },
          }),
        );
    } else return false;
    return true;
  };
  const loadedLists = () =>
    host.calls.filter((call) => call.method === "thread/loaded/list").length;
  try {
    reverted.turns = reverted.turns.slice(0, 1);
    host.notify("thread/reverted", { threadId: reverted.id });
    const reloadError = page.getByText("会话历史加载失败，正在重试…", {
      exact: true,
    });
    await expect(reloadError).toBeVisible();
    await expect(page.locator(".welcome")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "重试", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => replacementReads, { timeout: 10000 }).toBe(2);
    const duringRetry = loadedLists();
    await expect
      .poll(loadedLists, { timeout: 10000 })
      .toBeGreaterThanOrEqual(duringRetry + 2);
    assert.equal(replacementReads, 2, "only one reset retry may be in flight");
    finishReplacement();
    finishReplacement = null;
    await expect(revertedMessages).toHaveText(["撤回后保留的回复"]);
    await expect(reloadError).toHaveCount(0);
    assert.equal((await state()).historyReload, null);
    const afterRecovery = loadedLists();
    await expect
      .poll(loadedLists, { timeout: 10000 })
      .toBeGreaterThan(afterRecovery);
    assert.equal(replacementReads, 2, "a recovered shared chat stops retrying");
  } finally {
    finishReplacement?.();
    host.handler = null;
  }
  reverted.turns = [];
  host.notify("thread/reverted", { threadId: reverted.id });
  await expect(revertedMessages).toHaveCount(0);
  assert.equal((await state()).hasMore, false);
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("撤回后仍保留的草稿");
  reverted.turns = revertTurns();
  await page.evaluate(
    (id) => window.desktop.invoke("select", `codex:${id}`),
    reverted.id,
  );
  await expect(revertedMessages).toHaveCount(2);
  await deferredSelection(reverted, async (finishRead) => {
    reverted.turns = reverted.turns.slice(0, 1);
    host.notify("thread/reverted", { threadId: reverted.id });
    await expect(revertedMessages).toHaveText(["撤回后保留的回复"]);
    await finishRead();
    assert.deepEqual(
      (await state()).events
        .filter((event) => event.type === "turn/start")
        .map((event) => event.data.turn),
      ["retained"],
    );
    await expect(revertedMessages).toHaveText(["撤回后保留的回复"]);
  });
  assert.equal((await state()).completions.length, completionsBeforeRevert);
  // Reverting to an observed old head is not a new task. Preserve the bubble's
  // dismissal and completion priority when unload/reconnect reseeds history.
  const rollbackBubble = host.add("rollback-bubble");
  const bubbleId = `codex:${rollbackBubble.id}`;
  const bubbleEntry = async () => (await state()).progressEntries[bubbleId];
  const baselineTurn = savedTurn("before-buddy", "启动桌宠前的历史");
  rollbackBubble.turns = [baselineTurn];
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await page.evaluate((id) => window.desktop.invoke("select", id), bubbleId);
  await expect(revertedMessages).toHaveText(["启动桌宠前的历史"]);
  await page.evaluate(
    (id) => window.desktop.invoke("select", `codex:${id}`),
    reverted.id,
  );
  const firstBubbleTurn = host.start(rollbackBubble.id);
  host.finish(rollbackBubble.id, firstBubbleTurn);
  await expect.poll(async () => (await bubbleEntry())?.status).toBe("done");
  const secondBubbleTurn = host.start(rollbackBubble.id);
  host.finish(rollbackBubble.id, secondBubbleTurn);
  await expect
    .poll(async () => (await bubbleEntry())?.turn)
    .toBe(JSON.stringify(secondBubbleTurn.id));
  await expect.poll(async () => (await bubbleEntry())?.status).toBe("done");
  await page.evaluate(
    (id) => window.desktop.invoke("dismissProgress", id),
    bubbleId,
  );
  const dismissedBubble = await bubbleEntry();
  rollbackBubble.turns = [baselineTurn, firstBubbleTurn];
  host.notify("thread/reverted", { threadId: rollbackBubble.id });
  rollbackBubble.status = { type: "notLoaded" };
  host.notify("thread/status/changed", {
    threadId: rollbackBubble.id,
    status: rollbackBubble.status,
  });
  await page.evaluate(() => window.desktop.invoke("refresh"));
  assert.equal(
    (await state()).sessions.find((row) => row.sessionId === bubbleId).lastTurn
      .key,
    JSON.stringify(firstBubbleTurn.id),
  );
  assert.deepEqual(await bubbleEntry(), dismissedBubble);
  const initializes = host.calls.filter(
    (call) => call.method === "initialize",
  ).length;
  host.disconnect();
  await expect
    .poll(
      () => host.calls.filter((call) => call.method === "initialize").length,
      { timeout: 10000 },
    )
    .toBe(initializes + 1);
  await expect
    .poll(
      async () =>
        (await state()).sessions.find((row) => row.sessionId === bubbleId)
          ?.lastTurn?.key,
    )
    .toBe(JSON.stringify(firstBubbleTurn.id));
  assert.deepEqual(await bubbleEntry(), dismissedBubble);
  // An ancestor read only from history must preserve dismissal too.
  await page.evaluate((id) => window.desktop.invoke("select", id), bubbleId);
  rollbackBubble.turns = [baselineTurn];
  host.notify("thread/reverted", { threadId: rollbackBubble.id });
  await expect
    .poll(async () =>
      (await state()).events
        .filter((event) => event.type === "turn/start")
        .map((event) => event.data.turn),
    )
    .toEqual([baselineTurn.id]);
  host.disconnect();
  await expect
    .poll(
      () => host.calls.filter((call) => call.method === "initialize").length,
      { timeout: 10000 },
    )
    .toBe(initializes + 2);
  await expect
    .poll(
      async () =>
        (await state()).sessions.find((row) => row.sessionId === bubbleId)
          ?.lastTurn?.key,
    )
    .toBe(JSON.stringify(baselineTurn.id));
  assert.deepEqual(
    await bubbleEntry(),
    dismissedBubble,
    "history-only ancestors must also preserve dismissal",
  );
  // A genuinely new completed turn discovered after reconnect reopens it.
  host.disconnect();
  rollbackBubble.turns.push(savedTurn("new-after-rollback", "撤回后的新任务"));
  await expect
    .poll(
      () => host.calls.filter((call) => call.method === "initialize").length,
      { timeout: 10000 },
    )
    .toBe(initializes + 3);
  await expect
    .poll(async () => (await bubbleEntry())?.turn)
    .toBe(JSON.stringify("new-after-rollback"));
  const newBubble = await bubbleEntry();
  assert.equal(newBubble.hidden, false);
  assert.equal(newBubble.status, "done");
  assert(newBubble.completedAt > dismissedBubble.completedAt);

  // These ancestors never appeared as live tasks. Cross-page rollback cannot
  // rely on cached IDs; offline rollback cannot rely on a revert notification.
  for (const mode of ["cross-page", "offline"]) {
    const thread = host.add(`rollback-${mode}`),
      id = `codex:${thread.id}`;
    const count = mode === "cross-page" ? 40 : 2;
    thread.turns = Array.from({ length: count }, (_, i) =>
      savedTurn(`${mode}-old-${i + 1}`, `旧回复 ${i + 1}`),
    );
    host.handler = (frame, socket) => {
      if (
        frame.method !== "thread/turns/list" ||
        frame.params.threadId !== thread.id
      )
        return false;
      const ordered = [...thread.turns].reverse();
      const offset = frame.params.cursor
        ? ordered.findIndex((turn) => turn.id === frame.params.cursor) + 1
        : 0;
      const data = ordered.slice(offset, offset + frame.params.limit);
      socket.send(
        JSON.stringify({
          id: frame.id,
          result: {
            data,
            nextCursor:
              offset + data.length < ordered.length ? data.at(-1).id : null,
          },
        }),
      );
      return true;
    };
    const entry = async () => (await state()).progressEntries[id];
    const row = async () =>
      (await state()).sessions.find((row) => row.sessionId === id);
    const reconnect = async (change = () => {}) => {
      const epoch = (await state()).connections.codex.epoch;
      host.disconnect();
      await expect
        .poll(async () => (await state()).connections.codex.epoch)
        .toBeGreaterThan(epoch);
      change();
      await expect
        .poll(async () => (await state()).connections.codex.status, {
          timeout: 10000,
        })
        .toBe("connected");
      await expect
        .poll(async () => (await row())?.lastTurn?.key)
        .toBe(JSON.stringify(thread.turns.at(-1).id));
    };
    try {
      await page.evaluate(() => window.desktop.invoke("refresh"));
      await page.evaluate((id) => window.desktop.invoke("select", id), id);
      await expect(revertedMessages).toHaveCount(Math.min(count, 20));
      const observed = host.start(thread.id);
      host.finish(thread.id, observed);
      await expect.poll(async () => (await entry())?.status).toBe("done");
      await page.evaluate(
        (id) => window.desktop.invoke("dismissProgress", id),
        id,
      );
      const before = await entry();
      const rollback = () => {
        thread.turns = thread.turns.slice(0, mode === "cross-page" ? 5 : 1);
        thread.status = { type: "notLoaded" };
      };
      if (mode === "offline") await reconnect(rollback);
      else {
        rollback();
        host.notify("thread/reverted", { threadId: thread.id });
        host.notify("thread/status/changed", {
          threadId: thread.id,
          status: thread.status,
        });
        await page.evaluate(() => window.desktop.invoke("refresh"));
        await expect
          .poll(async () => (await row())?.lastTurn?.key)
          .toBe(JSON.stringify(thread.turns.at(-1).id));
      }
      assert.deepEqual(
        await entry(),
        before,
        `${mode} rollback preserves dismissal and completion priority`,
      );
      await reconnect();
      assert.deepEqual(
        await entry(),
        before,
        "repeated reconnect cannot forget the rollback decision",
      );
      await reconnect(() =>
        thread.turns.push(savedTurn(`${mode}-new`, "离线期间完成的新任务")),
      );
      const after = await entry();
      assert.equal(after.hidden, false);
      assert.equal(after.turn, JSON.stringify(thread.turns.at(-1).id));
      assert(after.completedAt > before.completedAt);
    } finally {
      host.handler = null;
    }
  }
  // External threads receive no revert notification; their regular history
  // poll must also replace an emptied history instead of retaining old replies.
  await page.evaluate(
    (id) => window.desktop.invoke("select", `codex:${id}`),
    refreshed.id,
  );
  await expect(revertedMessages).toHaveText(["自动刷新后的完整回复"]);
  refreshed.turns = [];
  await expect(revertedMessages).toHaveCount(0, { timeout: 10000 });

  // An old display-history page can fail while the newest turn remains fully
  // controllable. Exercise both buttons through the renderer and main process.
  const controls = host.add("controls-history-gap");
  controls.turns = [savedTurn("controls-old", "操作前的历史回复")];
  await page.evaluate(() => window.desktop.invoke("refresh"));
  await page.evaluate(
    (id) => window.desktop.invoke("select", `codex:${id}`),
    controls.id,
  );
  await expect(
    page.getByText("操作前的历史回复", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.desktop.invoke("select", "codex:thread-1"));
  host.handler = (frame, socket) => {
    if (
      frame.method !== "thread/turns/list" ||
      frame.params.threadId !== controls.id
    )
      return false;
    if (frame.params.cursor)
      socket.send(
        JSON.stringify({
          id: frame.id,
          error: {
            code: -32000,
            message: "older page temporarily unavailable",
          },
        }),
      );
    else {
      const data = [...controls.turns].reverse().slice(0, 20);
      socket.send(
        JSON.stringify({
          id: frame.id,
          result: { data, nextCursor: data.at(-1).id },
        }),
      );
    }
    return true;
  };
  try {
    for (let i = 0; i < 30; i++) {
      const turn = host.start(controls.id);
      host.finish(controls.id, turn);
    }
    const active = host.start(controls.id);
    await expect
      .poll(async () => (await state()).activity[`codex:${controls.id}`]?.turn)
      .toBe(JSON.stringify(active.id));
    await assert.rejects(
      page.evaluate(
        (id) => window.desktop.invoke("select", `codex:${id}`),
        controls.id,
      ),
      /older page temporarily unavailable/,
    );
    const before = host.calls.length;
    const message = page.getByRole("textbox", { name: "消息", exact: true });
    await message.fill("旧历史不可用时继续工作");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const steers = () =>
      host.calls
        .slice(before)
        .filter(
          (call) =>
            call.method === "turn/steer" &&
            call.params.threadId === controls.id,
        );
    await expect.poll(() => steers().length).toBe(1);
    assert.equal(steers()[0].params.expectedTurnId, active.id);
    assert.equal(steers()[0].params.input[0].text, "旧历史不可用时继续工作");
    await expect(message).toHaveValue("");
    await page
      .getByRole("button", { name: "停止当前轮次", exact: true })
      .click();
    const interrupts = () =>
      host.calls
        .slice(before)
        .filter(
          (call) =>
            call.method === "turn/interrupt" &&
            call.params.threadId === controls.id,
        );
    await expect.poll(() => interrupts().length).toBe(1);
    assert.equal(interrupts()[0].params.turnId, active.id);
    await expect
      .poll(
        async () =>
          (await state()).sessions.find(
            (s) => s.sessionId === `codex:${controls.id}`,
          )?.running,
      )
      .toBe(false);
    await expect(
      page.getByText("older page temporarily unavailable", { exact: true }),
    ).toHaveCount(0);
  } finally {
    host.handler = null;
  }
  await page.evaluate(() => window.desktop.invoke("select", "codex:thread-1"));
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("草稿保留");
  await page.evaluate(() => window.desktop.invoke("section", "settings"));
  await page.locator("#provider").selectOption("dsh");
  await page.locator("#endpoint").fill(dsh.endpoint);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect
    .poll(async () => (await state()).connections.dsh.status)
    .toBe("connected");
  await expect
    .poll(async () => (await state()).balance?.balances[0]?.total)
    .toBe(12.34);
  assert.deepEqual((await state()).pending, []);
  assert.equal((await state()).selectedId, "codex:thread-1");
  await page.locator("#provider").selectOption("codex");
  await expect(page.locator("#endpoint")).toHaveValue(host.endpoint);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect.poll(async () => (await state()).config.provider).toBe("codex");
  await expect.poll(async () => (await state()).connection).toBe("connected");
  assert.equal((await state()).balance.balances[0].total, 12.34);
  await expect(
    page.getByRole("heading", { name: "DeepSeek 余额", exact: true }),
  ).toHaveCount(1);
  assert.deepEqual(errors, []);
  console.log(
    "Codex Electron smoke passed: send, stream, usage, approval, question, background, cancel, reconnect, read-only desktop history, polling, concurrent history freshness and chronology, multi-page gaps with older pagination, notified/external history reverts with late reads, failed reset recovery without duplicate retries, rollback bubble retention through unload/reconnect, cross-page and offline rollback with repeated reconnects and subsequent new work, and controls with unavailable old history.",
  );
} finally {
  await app?.close();
  await host.close();
  await dsh.close();
  await rm(data, { recursive: true, force: true });
}
