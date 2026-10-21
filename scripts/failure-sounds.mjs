import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";

export async function checkFailureSounds() {
  const fixture = await createFixture();
  fixture.sessions.set("task", {
    sessionId: "task",
    title: "Failure lifecycle",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  const data = await mkdtemp(join(tmpdir(), "dsg-failure-sounds-"));
  const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        selectedId: "task",
        alwaysOnTop: false,
        idleExpressions: false,
        petPosition: { x: 500, y: 300 },
        sounds: { pet: false, idle: false, started: false },
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
    await page.evaluate(() => {
      window.failureProbe = {
        starts: [],
        stops: [],
        active: 0,
        blocked: false,
        release: null,
      };
      window.desktop.subscribe((state) => {
        window.failureProbe.status = state.activity.task?.status;
        window.failureProbe.voice = state.config.sounds.voice;
      });
      const bytes = new WeakMap(),
        buffers = new WeakMap();
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const kind = String(args[0]).match(/\/([^/]+)\.wav$/)?.[1];
        if (kind?.startsWith("failure") && window.failureProbe.blocked)
          await new Promise((resolve) => {
            window.failureProbe.release = resolve;
            window.failureProbe.heldAt = performance.now();
          });
        const response = await nativeFetch(...args);
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const data = await read();
          bytes.set(data, kind);
          return data;
        };
        return response;
      };
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        async decodeAudioData(data) {
          const buffer = await super.decodeAudioData(data);
          buffers.set(buffer, bytes.get(data));
          return buffer;
        }
        createBufferSource() {
          const source = super.createBufferSource();
          const start = source.start.bind(source),
            stop = source.stop.bind(source);
          source.start = (...args) => {
            window.failureProbe.active++;
            window.failureProbe.starts.push(buffers.get(source.buffer));
            return start(...args);
          };
          source.stop = (...args) => {
            window.failureProbe.stops.push(buffers.get(source.buffer));
            return stop(...args);
          };
          source.addEventListener("ended", () => window.failureProbe.active--);
          return source;
        }
      };
    });
    const count = () => page.evaluate(() => window.failureProbe.starts.length);
    const rest = () =>
      expect
        .poll(() => page.evaluate(() => window.failureProbe.active))
        .toBe(0);
    const status = (value) =>
      page.waitForFunction(
        (expected) => window.failureProbe.status === expected,
        value,
      );
    const quiet = async (expected) => {
      await page.waitForTimeout(200);
      assert.equal(await count(), expected);
    };
    const start = async () => {
      fixture.sessions.get("task").running = true;
      fixture.event("task", "turn/start", {});
      await status("thinking");
    };
    const failure = (id) =>
      fixture.push(
        "host",
        {
          type: "host/agent-error",
          sessionId: "task",
          message: "Provider failed",
        },
        id,
      );
    const output = async () => {
      fixture.event("task", "assistant/message", {
        message: {
          content: [{ type: "text", text: "Late output before failure" }],
        },
      });
      await status("replying");
      // Allow React's effects to refresh the active/pending playback.
      await page.waitForTimeout(50);
    };
    const end = async () => {
      fixture.sessions.get("task").running = false;
      fixture.event("task", "turn/end", {
        reason: { kind: "error", error: { message: "Provider failed" } },
      });
      await status("error");
    };
    const hold = () =>
      page.evaluate(() => {
        window.failureProbe.blocked = true;
        window.failureProbe.release = null;
      });
    const held = () =>
      page.waitForFunction(
        () => typeof window.failureProbe.release === "function",
      );
    const release = async () => {
      const elapsed = await page.evaluate(() => {
        window.failureProbe.blocked = false;
        window.failureProbe.release();
        return performance.now() - window.failureProbe.heldAt;
      });
      assert.ok(
        elapsed < 1000,
        `test must release before the load deadline (${elapsed} ms)`,
      );
    };

    await start();
    await hold();
    failure("loading");
    await held();
    await output();
    await release();
    await expect.poll(count).toBe(1);
    await end();
    await rest();
    await quiet(1);
    assert.deepEqual(await page.evaluate(() => window.failureProbe.stops), []);

    await start();
    failure("playing");
    await expect.poll(count).toBe(2);
    await output();
    assert.equal(await page.evaluate(() => window.failureProbe.active), 1);
    await end();
    await rest();
    await quiet(2);
    assert.deepEqual(await page.evaluate(() => window.failureProbe.stops), []);

    // New work still cancels obsolete failures, both before and after start().
    // A fresh voice guarantees a real fetch rather than an already cached clip.
    await invoke("soundSettings", { voice: SOUND_VOICES[1].id });
    await page.waitForFunction(
      (voice) => window.failureProbe.voice === voice,
      SOUND_VOICES[1].id,
    );
    await start();
    await hold();
    failure("loading-obsolete");
    await held();
    await start();
    await page.waitForTimeout(50);
    await release();
    await quiet(2);

    failure("playing-obsolete");
    await expect.poll(count).toBe(3);
    await start();
    await rest();
    await quiet(3);
    assert.equal(
      (await page.evaluate(() => window.failureProbe.stops)).length,
      1,
    );
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.calls.some((call) => call.path === "/api/session.prompt"),
      false,
    );
    console.log(
      "Failure lifecycle passed: late output preserves loading and playing audio, paired terminal reports do not replay, natural playback reaches ended without stop, and new turns cancel both pending and active failures.",
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
}
