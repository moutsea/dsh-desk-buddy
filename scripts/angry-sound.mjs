import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";

export async function checkAngrySound() {
  const fixture = await createFixture();
  fixture.sessions.set("pet", {
    sessionId: "pet",
    title: "Pet sounds",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  const data = await mkdtemp(join(tmpdir(), "dsg-angry-sound-"));
  const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        selectedId: "pet",
        alwaysOnTop: false,
        petPosition: { x: 500, y: 300 },
        idleExpressions: false,
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
    await page.clock.install();
    await page.evaluate(() => {
      window.angryProbe = {
        starts: [],
        stopped: [],
        active: 0,
        blocked: false,
        release: null,
      };
      const bytes = new WeakMap(),
        buffers = new WeakMap();
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const kind = String(args[0]).match(/\/([^/]+)\.wav$/)?.[1];
        if (kind === "angry" && window.angryProbe.blocked)
          await new Promise((resolve) => {
            window.angryProbe.release = resolve;
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
          const kind = bytes.get(data);
          const buffer = await super.decodeAudioData(data);
          buffers.set(buffer, kind);
          return buffer;
        }
        createBufferSource() {
          const source = super.createBufferSource();
          const start = source.start.bind(source),
            stop = source.stop.bind(source);
          source.start = (...args) => {
            window.angryProbe.starts.push(buffers.get(source.buffer));
            window.angryProbe.active++;
            return start(...args);
          };
          source.stop = (...args) => {
            window.angryProbe.stopped.push(buffers.get(source.buffer));
            return stop(...args);
          };
          source.addEventListener("ended", () => window.angryProbe.active--);
          return source;
        }
      };
    });
    const pet = page.getByRole("button", { name: "摸摸桌宠", exact: true });
    const starts = () => page.evaluate(() => window.angryProbe.starts);
    const quiet = async (expected) => {
      await page.waitForTimeout(150);
      assert.deepEqual(await starts(), expected);
    };
    const clicks = async (count) => {
      for (let n = 0; n < count; n++) await pet.dispatchEvent("click");
    };
    const rest = () =>
      expect.poll(() => page.evaluate(() => window.angryProbe.active)).toBe(0);
    await pet.click();
    await expect.poll(starts).toEqual(["pet"]);
    await clicks(3);
    await expect(pet.locator('[data-expression="love"]')).toBeVisible();
    await clicks(1);
    await expect(pet.locator('[data-expression="angry"]')).toBeVisible();
    await expect.poll(starts).toEqual(["pet", "angry"]);
    assert.ok(
      (await page.evaluate(() => window.angryProbe.stopped)).includes("pet"),
    );
    // Continue beyond the audio cooldown; a single continuous angry reaction
    // must still speak only once, and normal pet responses must stay quiet.
    for (let n = 0; n < 22; n++) {
      await page.clock.fastForward(350);
      await clicks(1);
    }
    await quiet(["pet", "angry"]);
    await rest();
    await page.clock.fastForward(6500);
    await expect(pet.locator('[data-expression="idle"]')).toBeVisible();
    await invoke("soundSettings", { pet: false });
    await invoke("section", "settings");
    const settings = page.getByRole("region", { name: "声音设置" });
    const preview = settings.getByRole("button", {
      name: "试听连点小脾气",
      exact: true,
    });
    const toggle = settings.getByRole("switch", {
      name: "连点小脾气声音",
      exact: true,
    });
    await expect(preview).toBeEnabled();
    await clicks(5);
    await expect.poll(starts).toEqual(["pet", "angry", "angry"]);
    await toggle.click();
    await expect(preview).toBeDisabled();
    await rest();
    await clicks(8);
    await quiet(["pet", "angry", "angry"]);
    await toggle.click();
    await expect(preview).toBeEnabled();
    await clicks(1);
    await quiet(["pet", "angry", "angry"]); // no replay after unmuting the same bout
    await preview.click();
    await expect.poll(starts).toEqual(["pet", "angry", "angry", "angry"]);
    await rest();

    // Manually choosing the angry expression does not itself produce speech,
    // and repeated touches cannot force an angry voice over a pinned expression.
    await page.clock.fastForward(6500);
    await expect(pet.locator('[data-expression="idle"]')).toBeVisible();
    await invoke("expression", "angry");
    await expect(pet.locator('[data-expression="angry"]')).toBeVisible();
    await clicks(6);
    await quiet(["pet", "angry", "angry", "angry"]);
    await invoke("expression", "auto");
    await page.clock.fastForward(6500);
    await expect(pet.locator('[data-expression="idle"]')).toBeVisible();
    await settings
      .getByLabel("声线", { exact: true })
      .selectOption(SOUND_VOICES[1].id);
    await expect(preview).toBeEnabled();
    await page.evaluate(() => {
      window.angryProbe.blocked = true;
    });
    await clicks(5);
    await page.waitForFunction(
      () => typeof window.angryProbe.release === "function",
    );
    await invoke("expression", "working");
    await expect(pet.locator('[data-expression="working"]')).toBeVisible();
    await page.evaluate(() => {
      window.angryProbe.blocked = false;
      window.angryProbe.release();
    });
    await invoke("expression", "auto");
    await quiet(["pet", "angry", "angry", "angry"]);
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(data, "settings.json"), "utf8"))
            .sounds,
      )
      .toMatchObject({ pet: false, angry: true });
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.calls.some((call) => call.path === "/api/session.prompt"),
      false,
    );
    console.log(
      "Angry sound passed: fifth touch, matching expression, pet preemption, continuous-click deduplication beyond cooldown, re-entry, independent mute/preview, no unmute replay, pinned-expression silence, stale-load cancellation.",
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
