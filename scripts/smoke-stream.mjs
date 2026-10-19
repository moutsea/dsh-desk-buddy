import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../tests/fixture.mjs";
const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-stream-"));
fixture.sessions.set("session", {
  sessionId: "session",
  running: true,
  blank: false,
  updatedAt: Date.now(),
  events: [],
});
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    selectedId: "session",
    alwaysOnTop: false,
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow();
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await page.evaluate(() => window.desktop.invoke("section", "chat"));
  fixture.event("session", "turn/start", { turn: 1 });
  const stream = (frame) =>
    fixture.push("mux", {
      type: "session/assistant-stream",
      sessionId: "session",
      frame,
    });
  stream({ type: "start", attemptId: "attempt-1", revision: 1 });
  const chunk = {
    type: "chunk",
    attemptId: "attempt-1",
    revision: 2,
    index: 0,
    chunk: { type: "text-delta", text: "桌面版正在回复" },
  };
  stream(chunk);
  await expect(page.getByText("桌面版正在回复", { exact: true })).toBeVisible();
  stream(chunk); // Duplicate frame must not duplicate text or invent a Session sequence.
  await expect
    .poll(async () => (await state()).liveAssistant.session.text)
    .toBe("桌面版正在回复");
  assert.equal((await state()).events.length, 1);
  fixture.event("session", "assistant/message", {
    turn: 1,
    step: 0,
    message: { content: [{ type: "text", text: "桌面版完整回复。" }] },
  });
  stream({
    type: "end",
    attemptId: "attempt-1",
    revision: 3,
    outcome: { kind: "committed" },
  });
  await expect(
    page.getByText("桌面版完整回复。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("桌面版正在回复", { exact: true })).toHaveCount(
    0,
  );
  stream({ type: "start", attemptId: "attempt-2", revision: 4 });
  stream({
    type: "chunk",
    attemptId: "attempt-2",
    revision: 5,
    chunk: { type: "text-delta", text: "断线前片段" },
  });
  await expect(page.getByText("断线前片段", { exact: true })).toBeVisible();
  fixture.dropStreams();
  await expect
    .poll(async () => (await state()).liveAssistant.session)
    .toBeUndefined();
  await expect(page.getByText("断线前片段", { exact: true })).toHaveCount(0);
  console.log(
    "Desktop cursorless streaming UI passed: live text, duplicate suppression, durable replacement and reconnect cleanup. No model calls.",
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
