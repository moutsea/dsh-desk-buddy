import assert from "node:assert/strict";
import test from "node:test";
import { expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { createCodexHost } from "../tests/helpers/codex-host.mjs";

const data = await mkdtemp(join(tmpdir(), "dsg-progress-lifecycle-"));
let holdDsh;
const dsh = await createFixture({
  beforeRpcReply: ({ method }) => {
    if (method === "session.list" && holdDsh) return holdDsh();
  },
});
const codex = await createCodexHost({ persistEmptyThreads: false });
const newRow = (id) => ({
  sessionId: id,
  title: id,
  running: false,
  blank: false,
  updatedAt: Date.now(),
  events: [],
});
dsh.sessions.set("existing", newRow("existing"));
codex.add("existing");
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    enabledProviders: ["dsh", "codex"],
    provider: "dsh",
    endpoint: dsh.endpoint,
    codexEndpoint: codex.endpoint,
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
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const invoke = (a, p) =>
    page.evaluate(([a, p]) => window.desktop.invoke(a, p), [a, p]);
  const card = (id) => page.locator(`.progress-card[data-session-id="${id}"]`);
  await expect.poll(async () => (await state()).sessions.length).toBe(2);
  await page.mouse.move(-10, -10);

  await test("old starts stay closed and old ends cannot terminate the next task", async () => {
    const id = "existing";
    dsh.sessions.get(id).running = true;
    const start = dsh.event(id, "turn/start", { turn: 1 });
    await expect(card(id)).toBeAttached();
    dsh.sessions.get(id).running = false;
    const end = dsh.event(id, "turn/end", { turn: 1, reason: "completed" });
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
    await expect(card(id)).toHaveCount(0);
    // A later mux event acts as a barrier, proving the replay reached the app.
    const replay = async (event) => {
      dsh.push("mux", { type: "session/event", sessionId: id, event });
      const marker = dsh.event(id, "usage/marker", {});
      await expect
        .poll(async () => (await state()).activity[id]?.seq)
        .toBe(marker.seq);
    };
    await replay(start);
    assert.equal((await state()).progressEntries[id].hidden, true);
    assert.equal(
      (await state()).sessions.find((row) => row.sessionId === id).running,
      false,
    );
    await expect(card(id)).toHaveCount(0);
    dsh.sessions.get(id).running = true;
    dsh.event(id, "turn/start", { turn: 2 });
    await expect(card(id)).toContainText("正在思考");
    await invoke("dismissProgress", id);
    await replay(end);
    assert.equal((await state()).progressEntries[id].active, true);
    assert.equal((await state()).progressEntries[id].hidden, true);
    await expect(card(id)).toHaveCount(0);
    dsh.sessions.get(id).running = false;
    dsh.event(id, "turn/end", { turn: 2, reason: "completed" });
  });

  await test("delayed DSH host statuses cannot reopen the current dismissed turn", async () => {
    const id = "existing";
    dsh.sessions.get(id).running = true;
    dsh.event(id, "turn/start", { turn: 3 });
    await expect(card(id)).toContainText("正在思考");
    await invoke("dismissProgress", id);
    await expect(card(id)).toHaveCount(0);
    const refreshStatus = async (running) => {
      const revision = (await state()).sessions.find(
        (row) => row.sessionId === id,
      ).metadataRevision;
      dsh.push("host", { type: "host/session-status", sessionId: id, running });
      // A completed fresh list is a barrier: both the host notification and
      // its verification have reached the main process before assertions.
      await expect
        .poll(
          async () =>
            (await state()).sessions.find((row) => row.sessionId === id)
              .metadataRevision,
        )
        .toBeGreaterThan(revision);
    };
    // The previous end and current start arrive late on the separate host
    // connection. Backend state still belongs to the same active turn.
    for (const running of [false, true]) {
      await refreshStatus(running);
      const entry = (await state()).progressEntries[id];
      assert.equal(entry.active, true);
      assert.equal(entry.hidden, true);
      assert.equal(entry.turn, "3");
      await expect(card(id)).toHaveCount(0);
    }
    dsh.sessions.get(id).running = false;
    dsh.event(id, "turn/end", { turn: 3, reason: "completed" });
    await expect
      .poll(async () => (await state()).progressEntries[id].active)
      .toBe(false);
    await refreshStatus(true); // stale host start after the task already ended
    assert.equal((await state()).progressEntries[id].hidden, true);
    await expect(card(id)).toHaveCount(0);
    // A genuine status-only task still opens, finishes and remains retained.
    dsh.sessions.get(id).running = true;
    await refreshStatus(true);
    await expect(card(id)).toContainText("正在思考");
    dsh.sessions.get(id).running = false;
    await refreshStatus(false);
    await expect(card(id)).toContainText("本轮已结束");
    await invoke("dismissProgress", id);
    dsh.sessions.get(id).running = true;
    dsh.event(id, "turn/start", { turn: 4 });
    await expect(card(id)).toContainText("正在思考");
    dsh.sessions.get(id).running = false;
    dsh.event(id, "turn/end", { turn: 4, reason: "completed" });
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  await test("Codex turns during read-only resume survive until fresh writable metadata arrives", async () => {
    const raw = "existing",
      id = "codex:existing";
    const first = codex.start(raw);
    codex.finish(raw, first);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
    for (const finishBeforeMetadata of [true, false]) {
      const thread = codex.sessions.get(raw);
      thread.status = { type: "notLoaded" };
      codex.notify("thread/status/changed", {
        threadId: raw,
        status: thread.status,
      });
      await invoke("refresh");
      assert.equal(
        (await state()).sessions.find((row) => row.sessionId === id).readOnly,
        true,
      );
      thread.status = { type: "idle" }; // another client reloads the thread
      let release, refreshing, turn;
      codex.handler = (frame, socket) => {
        if (frame.method !== "thread/resume" || frame.params.threadId !== raw)
          return;
        const snapshot = { ...thread, turns: [] };
        release = () =>
          socket.send(
            JSON.stringify({ id: frame.id, result: { thread: snapshot } }),
          );
        return true;
      };
      try {
        refreshing = invoke("refresh");
        await expect.poll(() => !!release).toBe(true);
        turn = codex.start(raw);
        codex.item(raw, turn, {
          id: `resume-tool-${turn.id}`,
          type: "commandExecution",
          command: "npm test",
          cwd: "/tmp/dsg-codex-test",
          status: "inProgress",
        });
        if (finishBeforeMetadata) codex.finish(raw, turn);
        await expect
          .poll(async () => (await state()).activity[id]?.status)
          .toBe(finishBeforeMetadata ? "done" : "working");
        const liveActivity = (await state()).activity[id];
        // Refreshing DSH includes cached Codex rows. It must not mistake the
        // old read-only metadata for a new verdict on the resumed turn.
        const title = `resume-${finishBeforeMetadata}`;
        dsh.sessions.get(raw).title = title;
        dsh.push("host", { type: "host/session-added", sessionId: raw });
        await expect
          .poll(
            async () =>
              (await state()).sessions.find((row) => row.sessionId === raw)
                ?.title,
          )
          .toBe(title);
        assert.equal(
          (await state()).sessions.find((row) => row.sessionId === id).readOnly,
          true,
        );
        assert.deepEqual(
          (await state()).activity[id],
          liveActivity,
          "another provider's cached metadata cannot erase the current phase or terminal state",
        );
        await expect(card(id)).toHaveCount(0);
      } finally {
        codex.handler = null;
        release?.();
        await refreshing;
      }
      await expect(card(id)).toContainText(
        finishBeforeMetadata ? "已完成" : "bash · npm test",
      );
      assert.equal(
        (await state()).progressEntries[id].turn,
        JSON.stringify(turn.id),
      );
      await invoke("dismissProgress", id);
      if (!finishBeforeMetadata) codex.finish(raw, turn);
      await expect
        .poll(async () => (await state()).progressEntries[id].active)
        .toBe(false);
      await expect(card(id)).toHaveCount(0);
    }
    const next = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, next);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  await test("Codex duplicate turn notifications during refresh preserve dismissal and current work", async () => {
    const raw = "existing",
      id = "codex:existing";
    let marker = 0;
    const replayDuringRefresh = async (method, turn) => {
      let release, refreshing;
      codex.handler = (frame, socket) => {
        if (frame.method !== "thread/read" || frame.params.threadId !== raw)
          return;
        const thread = structuredClone(codex.sessions.get(raw));
        release = () =>
          socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
        return true;
      };
      try {
        refreshing = invoke("refresh");
        await expect.poll(() => !!release).toBe(true);
        codex.notify(method, { threadId: raw, turn });
        codex.notify("thread/tokenUsage/updated", {
          threadId: raw,
          tokenUsage: {
            total: {
              inputTokens: ++marker,
              cachedInputTokens: 0,
              outputTokens: 1,
            },
          },
        });
        await expect
          .poll(
            async () =>
              (await state()).sessions.find((row) => row.sessionId === id)
                ?.projections?.values?.tokenUsage?.uncachedInputTokens,
          )
          .toBe(marker);
      } finally {
        codex.handler = null;
        release?.();
        await refreshing;
      }
    };
    const first = codex.start(raw),
      started = structuredClone(first);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, first);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
    await expect(card(id)).toHaveCount(0);
    const before = await state();
    await replayDuringRefresh("turn/started", started);
    let after = await state();
    assert.deepEqual(after.progressEntries[id], before.progressEntries[id]);
    assert.equal(
      after.sessions.find((row) => row.sessionId === id).running,
      false,
    );
    assert.equal(after.completions.length, before.completions.length);
    assert.equal(after.taskSounds.length, before.taskSounds.length);
    await expect(card(id)).toHaveCount(0);
    const second = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.notify("item/agentMessage/delta", {
      threadId: raw,
      turnId: second.id,
      itemId: "duplicate-review-reply",
      delta: "第二轮仍在回复",
    });
    await expect(card(id)).toContainText("第二轮仍在回复");
    await invoke("dismissProgress", id);
    await replayDuringRefresh("turn/completed", first);
    after = await state();
    assert.equal(
      after.sessions.find((row) => row.sessionId === id).running,
      true,
    );
    assert.equal(after.progressEntries[id].active, true);
    assert.equal(after.progressEntries[id].hidden, true);
    assert.equal(after.progressEntries[id].turn, JSON.stringify(second.id));
    assert.equal(after.liveAssistant[id]?.text, "第二轮仍在回复");
    await expect(card(id)).toHaveCount(0);
    codex.finish(raw, second);
    await expect
      .poll(async () => (await state()).progressEntries[id].active)
      .toBe(false);
    await expect(card(id)).toHaveCount(0);
    const third = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, third);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  await test("a newly polled Codex bubble survives completion and unload before history cache refresh", async () => {
    await invoke("refresh");
    const lists = () =>
      codex.calls.filter((call) => call.method === "thread/list").length;
    const before = lists(),
      raw = "newly-polled",
      id = `codex:${raw}`;
    codex.add(raw);
    const turn = codex.start(raw); // No thread/started: discovered only by polling.
    await expect(card(id)).toContainText("正在思考", { timeout: 10000 });
    assert.equal(lists(), before, "stored cache is still fresh");
    codex.finish(raw, turn);
    await expect(card(id)).toContainText("已完成");
    codex.sessions.get(raw).status = { type: "notLoaded" };
    codex.notify("thread/status/changed", {
      threadId: raw,
      status: { type: "notLoaded" },
    });
    await expect
      .poll(
        async () =>
          (await state()).sessions.find((row) => row.sessionId === id)
            ?.readOnly,
        { timeout: 10000 },
      )
      .toBe(true);
    assert.equal(
      lists(),
      before + 1,
      "unload verifies history despite the TTL",
    );
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
    await invoke("refresh");
    assert.equal((await state()).progressEntries[id].hidden, true);
    await expect(card(id)).toHaveCount(0);
    codex.sessions.delete(raw);
    await invoke("refresh");
    assert.equal((await state()).progressEntries[id], undefined);
  });

  await test("Codex completion and dismissal survive unloading while another thread is being read", async () => {
    const raw = "existing",
      id = `codex:${raw}`,
      blocker = "unload-list-blocker";
    codex.add(blocker);
    await invoke("refresh");
    try {
      for (const hidden of [false, true]) {
        const turn = codex.start(raw);
        await expect(card(id)).toContainText("正在思考");
        if (hidden) await invoke("dismissProgress", id);
        let release, refreshing, completed;
        codex.handler = (frame, socket) => {
          if (
            frame.method !== "thread/read" ||
            frame.params.threadId !== blocker
          )
            return;
          const thread = { ...codex.sessions.get(blocker), turns: [] };
          release = () =>
            socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
          return true;
        };
        try {
          refreshing = invoke("refresh");
          await expect.poll(() => !!release).toBe(true);
          codex.finish(raw, turn);
          codex.sessions.get(raw).status = { type: "notLoaded" };
          codex.notify("thread/status/changed", {
            threadId: raw,
            status: { type: "notLoaded" },
          });
          // This later notification proves completion AND unload were processed
          // before the held list returns. No arbitrary timing delay is needed.
          const marker = hidden ? 902 : 901;
          codex.notify("thread/tokenUsage/updated", {
            threadId: raw,
            tokenUsage: {
              total: {
                inputTokens: marker,
                cachedInputTokens: 0,
                outputTokens: 1,
              },
            },
          });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find((row) => row.sessionId === id)
                  ?.projections?.values?.tokenUsage?.uncachedInputTokens,
            )
            .toBe(marker);
          completed = await state();
          assert.ok(completed.progressEntries[id].completedAt > 0);
          if (hidden) await expect(card(id)).toHaveCount(0);
          else await expect(card(id)).toContainText("已完成");
        } finally {
          codex.handler = null;
          release?.();
          await refreshing;
        }
        for (let refresh = 0; refresh < 2; refresh++) {
          const after = await state();
          assert.equal(
            after.sessions.find((row) => row.sessionId === id)?.readOnly,
            true,
          );
          assert.deepEqual(after.progressEntries[id], {
            active: false,
            hidden,
            turn: JSON.stringify(turn.id),
            status: "done",
            completedAt: completed.progressEntries[id].completedAt,
          });
          for (const key of ["taskSounds", "completions"])
            assert.deepEqual(
              after[key],
              completed[key],
              "list reconciliation must not replay alerts",
            );
          if (hidden) await expect(card(id)).toHaveCount(0);
          else await expect(card(id)).toContainText("已完成");
          await invoke("refresh");
        }
        await invoke("dismissProgress", id);
        codex.sessions.get(raw).status = { type: "idle" };
        await invoke("refresh");
        await expect(card(id)).toHaveCount(0);
        const next = codex.start(raw);
        await expect(card(id)).toContainText("正在思考");
        codex.finish(raw, next);
        await expect(card(id)).toContainText("已完成");
        await invoke("dismissProgress", id);
      }
    } finally {
      codex.sessions.delete(blocker);
      await invoke("refresh");
    }
  });

  await test("owned Codex drafts retain their first completed bubble when history predates materialization", async () => {
    for (const hidden of [false, true]) {
      const id = await invoke("create", { provider: "codex" }),
        raw = id.slice("codex:".length),
        blocker = `draft-history-blocker-${hidden}`;
      assert.equal(
        (await state()).sessions.find((row) => row.sessionId === id).readOnly,
        false,
      );
      assert.equal(
        codex.storedThreads().some((thread) => thread.id === raw),
        false,
      );
      codex.add(blocker);
      let release, refreshing, turn, completed;
      try {
        codex.handler = (frame, socket) => {
          if (
            frame.method !== "thread/read" ||
            frame.params.threadId !== blocker
          )
            return;
          const thread = { ...codex.sessions.get(blocker), turns: [] };
          release = () =>
            socket.send(JSON.stringify({ id: frame.id, result: { thread } }));
          return true;
        };
        try {
          refreshing = invoke("refresh");
          await expect.poll(() => !!release).toBe(true);
          await invoke("send", { sessionId: id, text: "fixture first task" });
          await expect(card(id)).toContainText("正在思考");
          if (hidden) await invoke("dismissProgress", id);
          turn = codex.sessions.get(raw).turns.at(-1);
          codex.finish(raw, turn);
          codex.sessions.get(raw).status = { type: "notLoaded" };
          codex.notify("thread/status/changed", {
            threadId: raw,
            status: { type: "notLoaded" },
          });
          const marker = hidden ? 1002 : 1001;
          codex.notify("thread/tokenUsage/updated", {
            threadId: raw,
            tokenUsage: {
              total: {
                inputTokens: marker,
                cachedInputTokens: 0,
                outputTokens: 1,
              },
            },
          });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find((row) => row.sessionId === id)
                  ?.projections?.values?.tokenUsage?.uncachedInputTokens,
            )
            .toBe(marker);
          completed = await state();
          assert.equal(completed.progressEntries[id].status, "done");
          assert.ok(completed.progressEntries[id].completedAt > 0);
        } finally {
          codex.handler = null;
          release?.();
          release = null;
          await refreshing;
          refreshing = null;
        }
        for (let refresh = 0; refresh < 2; refresh++) {
          const after = await state();
          assert.equal(
            after.sessions.find((row) => row.sessionId === id)?.readOnly,
            true,
          );
          assert.deepEqual(after.progressEntries[id], {
            active: false,
            hidden,
            turn: JSON.stringify(turn.id),
            status: "done",
            completedAt: completed.progressEntries[id].completedAt,
          });
          for (const key of ["completions", "taskSounds"])
            assert.deepEqual(
              after[key],
              completed[key],
              "verification must not replay alerts",
            );
          if (hidden) await expect(card(id)).toHaveCount(0);
          else await expect(card(id)).toContainText("已完成");
          await invoke("refresh");
        }
        await invoke("dismissProgress", id);
        codex.sessions.get(raw).status = { type: "idle" };
        await invoke("refresh");
        assert.equal((await state()).progressEntries[id].hidden, true);
        await expect(card(id)).toHaveCount(0);
        const next = codex.start(raw);
        await expect(card(id)).toContainText("正在思考");
        codex.finish(raw, next);
        await expect(card(id)).toContainText("已完成");
      } finally {
        codex.handler = null;
        release?.();
        await refreshing?.catch(() => {});
        codex.sessions.delete(raw);
        codex.sessions.delete(blocker);
        await invoke("refresh");
      }
      assert.equal((await state()).progressEntries[id], undefined);
    }
  });

  for (const provider of ["dsh", "codex"]) {
    await test(`${provider} keeps the same turn dismissed across reconnect and reveals work begun offline`, async () => {
      const raw = "existing",
        id = provider === "codex" ? `codex:${raw}` : raw;
      let serial = 100;
      const start = () => {
        if (provider === "codex") return codex.start(raw);
        dsh.sessions.get(raw).running = true;
        const turn = { id: ++serial };
        dsh.event(raw, "turn/start", { turn: turn.id });
        return turn;
      };
      const finish = (turn) => {
        if (provider === "codex") return codex.finish(raw, turn);
        dsh.sessions.get(raw).running = false;
        dsh.event(raw, "turn/end", { turn: turn.id, reason: "completed" });
      };
      const reconnect = async (offline) => {
        const before = await state();
        if (provider === "dsh") dsh.dropStreams();
        else codex.disconnect();
        await expect
          .poll(async () => (await state()).connections[provider].epoch)
          .toBeGreaterThan(before.connections[provider].epoch);
        offline?.();
        await expect
          .poll(async () => (await state()).connections[provider].status)
          .toBe("connected");
        await expect
          .poll(
            async () =>
              (await state()).sessions.find((row) => row.sessionId === id)
                ?.metadataRevision,
          )
          .toBeGreaterThan(
            before.sessions.find((row) => row.sessionId === id)
              .metadataRevision,
          );
        const after = await state();
        assert.equal(
          after.taskSounds.filter((item) => item.sessionId === id).length,
          0,
          "history must not generate voice cues",
        );
        assert.equal(
          after.completions.filter((item) => item.sessionId === id).length,
          0,
          "history must not replay completion reactions",
        );
      };
      const first = start();
      await expect(card(id)).toContainText("正在思考");
      await invoke("dismissProgress", id);
      await reconnect();
      assert.equal((await state()).progressEntries[id].hidden, true);
      await expect(card(id)).toHaveCount(0);
      let second;
      await reconnect(() => {
        finish(first);
        second = start();
      });
      await expect(card(id)).toContainText("正在思考");
      assert.equal(
        (await state()).progressEntries[id].turn,
        JSON.stringify(second.id),
      );
      finish(second);
      await expect(card(id)).toContainText("已完成");
      await invoke("dismissProgress", id);
      let third;
      await reconnect(() => {
        third = start();
        finish(third);
      });
      await expect(card(id)).toContainText("已完成");
      assert.equal(
        (await state()).progressEntries[id].turn,
        JSON.stringify(third.id),
      );
      await invoke("dismissProgress", id);
      await invoke("refresh");
      await expect(card(id)).toHaveCount(0);
    });
  }

  for (const provider of ["dsh", "codex"]) {
    await test(`${provider} hides its bubbles until reconnect metadata arrives while the other platform stays visible`, async () => {
      const raw = "existing",
        id = provider === "codex" ? `codex:${raw}` : raw,
        otherId = provider === "codex" ? raw : `codex:${raw}`;
      const dshTurn = provider === "dsh" ? 201 : 202;
      dsh.sessions.get(raw).running = true;
      dsh.event(raw, "turn/start", { turn: dshTurn });
      const codexTurn = codex.start(raw);
      await expect(card(id)).toContainText("正在思考");
      await expect(card(otherId)).toContainText("正在思考");
      const before = await state(),
        releases = [];
      let releaseConnection;
      if (provider === "dsh") {
        dsh.setStreamsAvailable(false);
        holdDsh = () => new Promise((resolve) => releases.push(resolve));
      } else {
        codex.handler = (frame, socket) => {
          if (frame.method === "initialize") {
            releaseConnection = () =>
              socket.send(
                JSON.stringify({
                  id: frame.id,
                  result: { userAgent: "codex-test" },
                }),
              );
            return true;
          }
          if (frame.method !== "thread/list") return;
          const data = [...codex.sessions.values()].map((row) => ({
            ...row,
            turns: [],
          }));
          releases.push(() =>
            socket.send(
              JSON.stringify({
                id: frame.id,
                result: { data, nextCursor: null },
              }),
            ),
          );
          return true;
        };
      }
      try {
        if (provider === "dsh") dsh.dropStreams();
        else codex.disconnect();
        await expect
          .poll(async () => (await state()).connections[provider].epoch)
          .toBeGreaterThan(before.connections[provider].epoch);
        await expect
          .poll(async () => (await state()).connections[provider].status)
          .toBe("reconnecting");
        await expect(card(id)).toHaveCount(0);
        await expect(card(otherId)).toContainText("正在思考");
        assert.deepEqual(
          (await state()).progressEntries[id],
          before.progressEntries[id],
        );
        if (provider === "dsh") dsh.setStreamsAvailable(true);
        else {
          await expect.poll(() => !!releaseConnection).toBe(true);
          releaseConnection();
          releaseConnection = null;
        }
        await expect
          .poll(async () => (await state()).connections[provider].status)
          .toBe("connected");
        await expect.poll(() => releases.length).toBeGreaterThan(0);
        // The socket is ready but its first fresh snapshot is still held.
        // Another source's refresh must not turn this placeholder into an end.
        if (provider === "codex") {
          dsh.sessions.get(raw).title = "reconnect-other-source";
          dsh.push("host", { type: "host/session-added", sessionId: raw });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find((row) => row.sessionId === raw)
                  ?.title,
            )
            .toBe("reconnect-other-source");
        } else {
          codex.sessions.get(raw).name = "reconnect-other-source";
          codex.notify("thread/name/updated", {
            threadId: raw,
            threadName: "reconnect-other-source",
          });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find(
                  (row) => row.sessionId === otherId,
                )?.title,
            )
            .toBe("reconnect-other-source");
        }
        assert.equal(
          (await state()).sessions.find((row) => row.sessionId === id)
            .runningKnown,
          false,
        );
        await expect(card(id)).toHaveCount(0);
        await expect(card(otherId)).toContainText("正在思考");
        assert.deepEqual(
          (await state()).progressEntries[id],
          before.progressEntries[id],
        );
      } finally {
        dsh.setStreamsAvailable(true);
        holdDsh = null;
        codex.handler = null;
        releaseConnection?.();
        for (const release of releases) release();
      }
      await expect(card(id)).toContainText("正在思考");
      assert.equal(
        (await state()).progressEntries[id].turn,
        before.progressEntries[id].turn,
      );
      dsh.sessions.get(raw).running = false;
      dsh.event(raw, "turn/end", { turn: dshTurn, reason: "completed" });
      codex.finish(raw, codexTurn);
      for (const finished of [id, otherId]) {
        await expect(card(finished)).toContainText("已完成");
        await invoke("dismissProgress", finished);
        await invoke("refresh");
        await expect(card(finished)).toHaveCount(0);
      }
    });
  }

  await test("closing a Codex task discovered on reattach stays closed when that task completes", async () => {
    const raw = "existing",
      id = `codex:${raw}`;
    const first = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, first);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
    codex.sessions.get(raw).status = { type: "notLoaded" };
    codex.notify("thread/status/changed", {
      threadId: raw,
      status: { type: "notLoaded" },
    });
    await invoke("refresh");
    assert.equal(
      (await state()).sessions.find((row) => row.sessionId === id).readOnly,
      true,
    );
    // The task starts before this client has a subscription, so its start is
    // present only in history and the next loaded metadata snapshot.
    const second = {
      id: "reattached-live-turn",
      status: "inProgress",
      items: [],
    };
    codex.sessions.get(raw).turns.push(second);
    codex.sessions.get(raw).status = { type: "active" };
    await invoke("refresh");
    await expect(card(id)).toContainText("正在思考");
    assert.equal(
      (await state()).progressEntries[id].turn,
      JSON.stringify(second.id),
    );
    await invoke("dismissProgress", id);
    await expect(card(id)).toHaveCount(0);
    codex.finish(raw, second);
    await expect
      .poll(async () => (await state()).progressEntries[id].active)
      .toBe(false);
    assert.equal((await state()).progressEntries[id].hidden, true);
    await expect(card(id)).toHaveCount(0);
    const third = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, third);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  await test("Codex restores a task completed and unloaded offline without surfacing unrelated old history", async () => {
    const raw = "existing",
      id = `codex:${raw}`;
    const first = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    await invoke("dismissProgress", id);
    const before = await state();
    codex.disconnect();
    await expect
      .poll(async () => (await state()).connections.codex.epoch)
      .toBeGreaterThan(before.connections.codex.epoch);
    codex.finish(raw, first);
    const second = codex.start(raw);
    codex.finish(raw, second);
    codex.sessions.get(raw).status = { type: "notLoaded" };
    const old = codex.add("unobserved-history");
    old.status = { type: "notLoaded" };
    old.turns.push({ id: "old-turn", status: "completed", items: [] });
    await expect
      .poll(async () => (await state()).connections.codex.status)
      .toBe("connected");
    await expect
      .poll(
        async () =>
          (await state()).sessions.find((row) => row.sessionId === id)
            ?.readOnly,
      )
      .toBe(true);
    await expect(card(id)).toContainText("已完成");
    const after = await state();
    assert.equal(after.progressEntries[id].turn, JSON.stringify(second.id));
    assert.equal(after.progressEntries["codex:unobserved-history"], undefined);
    await expect(card("codex:unobserved-history")).toHaveCount(0);
    assert.equal(
      after.taskSounds.filter((item) => item.sessionId === id).length,
      0,
    );
    assert.equal(
      after.completions.filter((item) => item.sessionId === id).length,
      0,
    );
    await invoke("dismissProgress", id);
    await invoke("refresh");
    await expect(card(id)).toHaveCount(0);
    // Reloading the same completed turn must still respect the new dismissal.
    codex.sessions.get(raw).status = { type: "idle" };
    await invoke("refresh");
    assert.equal((await state()).progressEntries[id].hidden, true);
    await expect(card(id)).toHaveCount(0);
  });

  await test("Codex retains a newly observed task completed and unloaded before its first list", async () => {
    const raw = "fast-unloaded",
      id = `codex:${raw}`,
      thread = codex.add(raw);
    let release, turn;
    codex.handler = (frame, socket) => {
      if (frame.method !== "thread/list") return;
      const snapshot = [...codex.sessions.values()].map((row) => ({
        ...row,
        turns: [],
      }));
      release = () =>
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: { data: snapshot, nextCursor: null },
          }),
        );
      return true;
    };
    codex.notify("thread/started", { thread });
    try {
      await expect.poll(() => !!release).toBe(true);
      turn = codex.start(raw);
      codex.finish(raw, turn);
      await expect
        .poll(async () => (await state()).activity[id]?.status)
        .toBe("done");
      assert.equal(
        (await state()).sessions.some((row) => row.sessionId === id),
        false,
      );
      thread.status = { type: "notLoaded" };
      codex.notify("thread/status/changed", {
        threadId: raw,
        status: thread.status,
      });
    } finally {
      codex.handler = null;
      release?.();
    }
    await expect
      .poll(
        async () =>
          (await state()).sessions.find((row) => row.sessionId === id)
            ?.readOnly,
      )
      .toBe(true);
    await expect(card(id)).toContainText("已完成");
    assert.equal(
      (await state()).progressEntries[id].turn,
      JSON.stringify(turn.id),
    );
    await invoke("dismissProgress", id);
    await invoke("refresh");
    await expect(card(id)).toHaveCount(0);
    // Reloading the same completed task respects dismissal; new work reopens it.
    thread.status = { type: "idle" };
    await invoke("refresh");
    await expect(card(id)).toHaveCount(0);
    const next = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, next);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  await test("Codex recovered terminal states survive repeated refreshes without prior-turn activity", async () => {
    const raw = "existing",
      id = `codex:${raw}`,
      thread = codex.sessions.get(raw);
    for (const [oldStatus, newStatus, expected, label] of [
      ["failed", "completed", "done", "已完成"],
      ["completed", "failed", "error", "执行出错"],
    ]) {
      const first = codex.start(raw);
      await expect(card(id)).toContainText("正在思考");
      first.error = { message: "上轮任务错误，不应带入新任务" };
      codex.finish(raw, first, oldStatus);
      await expect(card(id)).toContainText(
        oldStatus === "failed" ? "执行出错" : "已完成",
      );
      await invoke("dismissProgress", id);
      thread.status = { type: "notLoaded" };
      codex.notify("thread/status/changed", {
        threadId: raw,
        status: thread.status,
      });
      await invoke("refresh");
      assert.equal(
        (await state()).sessions.find((row) => row.sessionId === id).readOnly,
        true,
      );
      const before = await state();
      // This task finishes before resubscription; only history reports its result.
      const second = {
        id: `recovered-${newStatus}`,
        status: newStatus,
        items: [],
      };
      thread.turns.push(second);
      thread.status = { type: "idle" };
      for (let refresh = 0; refresh < 3; refresh++) {
        await invoke("refresh");
        await expect(card(id)).toContainText(label);
        await expect(card(id)).not.toContainText(first.error.message);
        const after = await state();
        assert.equal(after.progressEntries[id].turn, JSON.stringify(second.id));
        assert.equal(after.progressEntries[id].status, expected);
        assert.equal(after.activity[id].seq, before.activity[id].seq);
        assert.equal(after.activity[id].message, undefined);
        // Reconciliation cannot replay completion celebrations or task sounds.
        for (const key of ["taskSounds", "completions"])
          assert.deepEqual(
            after[key].filter((item) => item.sessionId === id),
            before[key].filter((item) => item.sessionId === id),
          );
      }
      await invoke("dismissProgress", id);
      await invoke("refresh");
      await expect(card(id)).toHaveCount(0);
    }
    const next = codex.start(raw);
    await expect(card(id)).toContainText("正在思考");
    codex.finish(raw, next);
    await expect(card(id)).toContainText("已完成");
    await invoke("dismissProgress", id);
  });

  for (const provider of ["dsh", "codex"]) {
    await test(`${provider} retains work that starts and finishes before the session list arrives`, async () => {
      const raw = `fast-${provider}`,
        id = provider === "codex" ? `codex:${raw}` : raw;
      let release;
      if (provider === "dsh") {
        dsh.sessions.set(raw, newRow(raw));
        holdDsh = () =>
          new Promise((resolve) => {
            release = resolve;
          });
        dsh.push("host", { type: "host/session-added", sessionId: raw });
      } else {
        const thread = codex.add(raw);
        codex.handler = (frame, socket) => {
          if (frame.method !== "thread/list") return;
          const snapshot = [...codex.sessions.values()].map((row) => ({
            ...row,
            turns: [],
          }));
          release = () =>
            socket.send(
              JSON.stringify({
                id: frame.id,
                result: { data: snapshot, nextCursor: null },
              }),
            );
          return true;
        };
        codex.notify("thread/started", { thread });
      }
      try {
        await expect.poll(() => !!release).toBe(true);
        if (provider === "dsh") {
          dsh.event(raw, "turn/start", { turn: 1 });
          dsh.event(raw, "turn/end", { turn: 1, reason: "completed" });
        } else {
          const turn = codex.start(raw);
          codex.finish(raw, turn);
        }
        await expect
          .poll(async () => (await state()).activity[id]?.status)
          .toBe("done");
        assert.equal(
          (await state()).sessions.some((row) => row.sessionId === id),
          false,
        );
        // Refreshing the other platform must not prune unresolved lifecycle data.
        if (provider === "dsh") {
          codex.sessions.get("existing").name = "other-refresh";
          codex.notify("thread/name/updated", {
            threadId: "existing",
            threadName: "other-refresh",
          });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find(
                  (row) => row.sessionId === "codex:existing",
                )?.title,
            )
            .toBe("other-refresh");
        } else {
          dsh.sessions.get("existing").title = "other-refresh";
          dsh.push("host", {
            type: "host/session-added",
            sessionId: "existing",
          });
          await expect
            .poll(
              async () =>
                (await state()).sessions.find(
                  (row) => row.sessionId === "existing",
                )?.title,
            )
            .toBe("other-refresh");
        }
      } finally {
        holdDsh = null;
        codex.handler = null;
        release?.();
      }
      await expect
        .poll(async () =>
          (await state()).sessions.some((row) => row.sessionId === id),
        )
        .toBe(true);
      await expect(card(id)).toContainText("已完成");
      await invoke("dismissProgress", id);
      await expect(card(id)).toHaveCount(0);
      if (provider === "dsh") {
        dsh.sessions.get(raw).running = true;
        dsh.event(raw, "turn/start", { turn: 2 });
      } else codex.start(raw);
      await expect(card(id)).toContainText("正在思考");
      assert.equal((await state()).surface.section, null);
    });
  }
} finally {
  await app?.close();
  await dsh.close();
  await codex.close();
  await rm(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
