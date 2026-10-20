import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-sound-"));
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
for (const sessionId of ["front", "back"])
  fixture.sessions.set(sessionId, {
    sessionId,
    title: sessionId,
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
    petPosition: { x: 500, y: 300 },
  }),
);
let app;
try {
  app = await launchDesktop(env);
  let page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const invoke = (action, payload) =>
    page.evaluate(
      ([actionName, value]) => window.desktop.invoke(actionName, value),
      [action, payload],
    );
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await page.evaluate(() => {
    window.audioProbe = { starts: [], contexts: [], peak: 0, output: null };
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        window.audioProbe.contexts.push(this);
        const analyser = this.createAnalyser();
        analyser.fftSize = 1024;
        const createGain = this.createGain.bind(this);
        let first = true;
        this.createGain = () => {
          const gain = createGain();
          if (first) {
            first = false;
            window.audioProbe.output = gain;
            gain.connect(analyser);
          }
          return gain;
        };
        const samples = new Float32Array(analyser.fftSize);
        setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          window.audioProbe.peak = Math.max(
            window.audioProbe.peak,
            ...samples.map(Math.abs),
          );
        }, 5);
      }
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (at) => {
          window.audioProbe.starts.push({
            frequency: oscillator.frequency.value,
            at,
          });
          start(at);
        };
        return oscillator;
      }
    };
  });
  const count = () => page.evaluate(() => window.audioProbe.starts.length);
  const quiet = async (expected) => {
    await page.waitForTimeout(350);
    assert.equal(await count(), expected);
  };
  const rest = () => page.waitForTimeout(1000);
  const turn = (sessionId, reason = "completed") => {
    fixture.event(sessionId, "turn/start", {});
    return fixture.event(sessionId, "turn/end", { reason: { kind: reason } });
  };
  await quiet(0);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].blur(),
  );
  const completed = turn("front");
  await expect.poll(count).toBe(4);
  await expect
    .poll(() => page.evaluate(() => window.audioProbe.peak))
    .toBeGreaterThan(0.005);
  assert.equal(
    await page.evaluate(() => window.audioProbe.contexts[0].state),
    "running",
    "completion plays before the first gesture",
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFocused(),
    ),
    false,
  );
  fixture.push("mux", {
    type: "session/event",
    sessionId: "front",
    event: completed,
  });
  await invoke("refresh");
  await quiet(4);
  await rest();
  turn("back");
  await expect.poll(count).toBe(8);
  await rest();
  turn("front", "error");
  turn("front", "cancelled");
  await quiet(8);
  await invoke("connect", fixture.endpoint);
  await expect.poll(async () => (await state()).connection).toBe("connected");
  await quiet(8);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  const pet = page.getByRole("button", { name: "摸摸桌宠", exact: true });
  await page.evaluate(() => {
    window.audioProbe.peak = 0;
  });
  await pet.click();
  await expect.poll(count).toBe(10);
  await rest();
  const lowPeak = await page.evaluate(() => window.audioProbe.peak);
  assert.ok(lowPeak > 0.005);
  await invoke("soundSettings", { volume: 70 });
  await expect.poll(async () => (await state()).config.sounds.volume).toBe(70);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.audioProbe.peak = 0;
  });
  await pet.click();
  await expect.poll(count).toBe(12);
  await rest();
  const highPeak = await page.evaluate(() => window.audioProbe.peak);
  assert.ok(
    highPeak > lowPeak * 1.6 && highPeak < lowPeak * 2.4,
    `volume scales synthesized signal: ${lowPeak} -> ${highPeak}`,
  );
  await pet.dispatchEvent("click");
  await pet.dispatchEvent("click");
  await pet.dispatchEvent("click");
  await expect.poll(count).toBe(14);
  await rest();
  const box = await pet.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 - 20,
  );
  await expect(page.locator(".pet-stage")).toHaveClass(/is-dragging/);
  await page.mouse.up();
  await quiet(14);
  await invoke("section", "settings");
  const settings = page.getByRole("region", { name: "声音设置" });
  await expect(
    settings.getByRole("switch", { name: "声音陪伴", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await settings
    .getByRole("button", { name: "试听任务完成", exact: true })
    .click();
  await expect.poll(count).toBe(18);
  await settings.getByRole("switch", { name: "声音陪伴", exact: true }).click();
  await expect
    .poll(async () => (await state()).config.sounds.enabled)
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.audioProbe.output.gain.value))
    .toBeLessThan(0.0001);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        window.audioProbe.peak = 0;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return window.audioProbe.peak;
      }),
    )
    .toBeLessThan(0.0001);
  await expect(
    settings.getByRole("button", { name: "试听任务完成" }),
  ).toBeDisabled();
  turn("front");
  await quiet(18);
  await settings.getByRole("switch", { name: "声音陪伴", exact: true }).click();
  await expect
    .poll(async () => (await state()).config.sounds.enabled)
    .toBe(true);
  await quiet(18);
  await settings
    .getByRole("switch", { name: "任务完成声音", exact: true })
    .click();
  await expect
    .poll(async () => (await state()).config.sounds.completion)
    .toBe(false);
  turn("back");
  await quiet(18);
  await settings
    .getByRole("switch", { name: "任务完成声音", exact: true })
    .click();
  await quiet(18);
  const volume = settings.getByRole("slider", { name: "音量", exact: true });
  await volume.focus();
  await volume.press("Home");
  await expect.poll(async () => (await state()).config.sounds.volume).toBe(0);
  await expect(
    settings.getByRole("button", { name: "试听摸摸桌宠" }),
  ).toBeDisabled();
  turn("front");
  await quiet(18);
  await volume.press("ArrowRight");
  await expect.poll(async () => (await state()).config.sounds.volume).toBe(5);
  await settings
    .getByRole("switch", { name: "摸摸桌宠声音", exact: true })
    .click();
  await expect.poll(async () => (await state()).config.sounds.pet).toBe(false);
  await expect(
    settings.getByRole("switch", { name: "摸摸桌宠声音", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await invoke("section", null);
  await pet.click();
  await quiet(18);
  await invoke("soundSettings", {
    pet: true,
    completion: true,
    idle: true,
    volume: 35,
  });
  await invoke("expression", "auto");
  await invoke("connect", fixture.endpoint);
  await page.clock.install();
  await page.clock.fastForward(15000);
  await invoke("section", "settings");
  await page.clock.fastForward(110000);
  assert.equal(await count(), 18, "open settings prevent idle sound");
  await invoke("section", null);
  await expect(page.locator(".companion-surface")).not.toBeVisible();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(110000);
  await expect.poll(count).toBe(20);
  await page.clock.fastForward(250000);
  assert.equal(await count(), 20, "sleeping prevents further idle sounds");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide(),
  );
  await page.clock.fastForward(110000);
  assert.equal(await count(), 20, "hidden pet stays quiet");
  await page.clock.setSystemTime(Date.now());
  turn("back");
  await expect.poll(count).toBe(24);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  await quiet(24);
  await invoke("soundSettings", { volume: 0, idle: false, pet: false });
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(data, "settings.json"), "utf8")).sounds,
    )
    .toMatchObject({ volume: 0, idle: false, pet: false, enabled: true });
  await mkdir("artifacts", { recursive: true });
  await invoke("section", "settings");
  await settings.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/sound-settings.png",
    omitBackground: true,
  });
  assert.deepEqual(errors, []);
  await app.close();
  app = await launchDesktop(env);
  page = await app.firstWindow();
  await expect.poll(async () => (await state()).connection).toBe("connected");
  assert.deepEqual((await state()).config.sounds, {
    enabled: true,
    volume: 0,
    pet: false,
    completion: true,
    idle: false,
  });
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/session.prompt"),
    false,
  );
  await writeFile(
    "artifacts/sound-result.json",
    JSON.stringify(
      {
        signalPeaks: { volume35: lowPeak, volume70: highPeak },
        completionBeforeGesture: true,
        backgroundCompletion: true,
        deduplication: true,
        muteStopsPlayback: true,
        idleSuppression: true,
        settingsPersisted: true,
        noModelCalls: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Sound passed: real audio signal before first gesture, background completion, click/drag distinction, cooldown, volume, mute, event switches, preview, sparse idle and sleeping/hidden suppression, restart persistence. No model calls.",
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
