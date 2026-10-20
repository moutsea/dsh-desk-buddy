import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createFixture } from "../tests/fixture.mjs";
import { launchDesktop } from "./electron-test.mjs";

// Keep a second session streaming while the first reports usage and completes.
// This covers publication latency through the real main process and renderer.
export async function checkLiveUpdates() {
  const fixture = await createFixture();
  const data = await mkdtemp(join(tmpdir(), "dsg-live-updates-"));
  const tokens = (outputTokens) => ({
    uncachedInputTokens: 1000,
    cacheReadTokens: 8000,
    cacheWriteTokens: 1000,
    outputTokens,
  });
  for (const sessionId of ["front", "streaming"])
    fixture.sessions.set(sessionId, {
      sessionId,
      title: sessionId,
      running: false,
      blank: false,
      updatedAt: Date.now(),
      events: [],
      projections: { asOfSeq: 10, values: { tokenUsage: tokens(2000) } },
    });
  const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, timer;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        selectedId: "front",
        alwaysOnTop: false,
        idleExpressions: false,
        animations: false,
        petPosition: { x: 500, y: 300 },
      }),
    );
    app = await launchDesktop(env);
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const invoke = (action, payload) =>
      page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    await invoke("section", "chat");
    const total = page.locator('[data-metric="total"]');
    await expect(total).toHaveText("12.0k");
    await page.evaluate(() => {
      window.liveUpdatesProbe = { starts: [], frames: 0 };
      window.desktop.subscribe(() => window.liveUpdatesProbe.frames++);
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        createBufferSource() {
          const source = super.createBufferSource();
          const start = source.start.bind(source);
          source.start = (...args) => {
            window.liveUpdatesProbe.starts.push(Date.now());
            return start(...args);
          };
          return source;
        }
      };
    });
    fixture.sessions.get("streaming").running = true;
    fixture.event("streaming", "turn/start", {});
    fixture.push("mux", {
      type: "session/assistant-stream",
      sessionId: "streaming",
      frame: { type: "start", revision: 0, attemptId: "live-updates" },
    });
    let revision = 0;
    timer = setInterval(
      () =>
        fixture.push("mux", {
          type: "session/assistant-stream",
          sessionId: "streaming",
          frame: {
            type: "chunk",
            revision: ++revision,
            attemptId: "live-updates",
            chunk: { type: "text-delta", text: "继续输出" },
          },
        }),
      5,
    );
    // Establish a continuous stream before reporting the other task's result.
    await expect
      .poll(
        async () => (await invoke("state")).liveAssistant.streaming?.revision,
      )
      .toBeGreaterThan(10);
    const framesBefore = await page.evaluate(
      () => window.liveUpdatesProbe.frames,
    );
    const update = (seq, output) => {
      const value = tokens(output);
      fixture.sessions.get("front").projections = {
        asOfSeq: seq,
        values: { tokenUsage: value },
      };
      fixture.push("mux", {
        type: "session/projection",
        sessionId: "front",
        key: "tokenUsage",
        value,
        seq,
      });
    };
    update(20, 38000);
    fixture.event("front", "turn/start", {});
    const completed = fixture.event("front", "turn/end", {
      reason: { kind: "completed" },
    });
    await expect(total).toHaveText("48.0k", { timeout: 2000 });
    await expect
      .poll(() => page.evaluate(() => window.liveUpdatesProbe.starts.length), {
        timeout: 2000,
      })
      .toBe(1);
    const firstPlayback = await page.evaluate(
      () => window.liveUpdatesProbe.starts[0],
    );
    assert.ok(
      firstPlayback - completed.time < 3000,
      "completion plays before the reminder can expire",
    );

    // Multiple writes in one window publish the latest value, and later windows
    // continue to publish even while the same assistant stream stays active.
    update(21, 50000);
    update(22, 60000);
    update(23, 62000);
    await expect(total).toHaveText("72.0k", { timeout: 2000 });
    await expect
      .poll(() => page.evaluate(() => window.liveUpdatesProbe.frames), {
        timeout: 2000,
      })
      .toBeGreaterThanOrEqual(framesBefore + 3);
    clearInterval(timer);
    timer = undefined;
    update(24, 86000);
    await expect(total).toHaveText("96.0k", { timeout: 2000 });
    await page.waitForTimeout(100);
    const probe = await page.evaluate(() => window.liveUpdatesProbe);
    assert.equal(
      probe.starts.length,
      1,
      "later state deliveries never replay the completion",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.calls.some((call) => call.path === "/api/session.prompt"),
      false,
    );
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/live-updates-result.json",
      JSON.stringify(
        {
          chunks: revision,
          rendererUpdates: probe.frames - framesBefore,
          completionLatencyMs: firstPlayback - completed.time,
          completionPlays: probe.starts.length,
          finalTotal: await total.textContent(),
        },
        null,
        2,
      ),
    );
    console.log(
      "Live updates passed: ongoing high-frequency output cannot starve usage or completion audio; coalesced updates retain the latest value and later isolated updates still arrive. No model calls.",
    );
  } finally {
    clearInterval(timer);
    await app?.close();
    await fixture.close();
    await rm(data, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
