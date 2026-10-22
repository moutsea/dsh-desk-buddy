import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";

export async function checkCompanionSounds() {
  const fixture = await createFixture();
  fixture.sessions.set("pet", {
    sessionId: "pet",
    title: "Companion",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  const data = await mkdtemp(join(tmpdir(), "dsg-companion-sounds-"));
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
        sounds: {
          pet: false,
          angry: false,
          idle: false,
          shy: true,
          wake: true,
          welcome: true,
          moved: true,
          reconnected: true,
        },
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].focus(),
    );
    await page.clock.install();
    await page.clock.pauseAt(
      new Date(await page.evaluate(() => Date.now() + 50)),
    );
    await page.evaluate(() => {
      window.companionProbe = {
        starts: [],
        stopped: [],
        active: 0,
        blocked: false,
        release: null,
      };
      window.desktop.subscribe((state) => {
        window.companionProbe.epoch = state.connectionEpoch;
      });
      const bytes = new WeakMap(),
        buffers = new WeakMap();
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const kind = String(args[0]).match(/\/([^/]+)\.wav$/)?.[1];
        if (kind === "angry" && window.companionProbe.blocked)
          await new Promise((resolve) => {
            window.companionProbe.release = resolve;
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
            window.companionProbe.starts.push(buffers.get(source.buffer));
            window.companionProbe.active++;
            return start(...args);
          };
          source.stop = (...args) => {
            window.companionProbe.stopped.push(buffers.get(source.buffer));
            return stop(...args);
          };
          source.addEventListener(
            "ended",
            () => window.companionProbe.active--,
          );
          return source;
        }
      };
    });
    const pet = page.getByRole("button", { name: "摸摸桌宠", exact: true });
    const starts = () => page.evaluate(() => window.companionProbe.starts);
    const expected = [];
    const heard = async (kind) => {
      expected.push(kind);
      await expect.poll(starts).toEqual(expected);
    };
    const quiet = async () => {
      await page.waitForTimeout(150);
      assert.deepEqual(await starts(), expected);
    };
    const rest = () =>
      expect
        .poll(() => page.evaluate(() => window.companionProbe.active))
        .toBe(0);
    const asleep = () =>
      expect(pet.locator('[data-expression="sleeping"]')).toBeVisible();
    await pet.hover();
    await page.clock.fastForward(7000);
    await quiet();
    await page.clock.fastForward(1100);
    await heard("shy");
    await rest();
    await page.mouse.move(1, 1);
    await page.clock.fastForward(6000);
    await pet.hover();
    await page.clock.fastForward(8001);
    await quiet(); // one minute cooldown
    await page.mouse.move(1, 1);
    await invoke("soundSettings", { sleep: true });
    // The renderer only learns about the change through the coalesced state
    // broadcast, which runs on a real 35ms timer in the main process: advancing
    // the mocked page clock does not flush it, so wait in real time.
    await page.waitForTimeout(150);
    await expect
      .poll(async () => (await invoke("state")).config.sounds.sleep)
      .toBe(true);
    await page.clock.fastForward(241000);
    await asleep();
    await heard("sleep");
    await rest();
    await pet.hover();
    await asleep();
    await quiet(); // hovering does not wake her
    await pet.click();
    await heard("wake");
    await rest();
    await invoke("soundSettings", { sleep: false });
    await page.waitForTimeout(150);
    await expect
      .poll(async () => (await invoke("state")).config.sounds.sleep)
      .toBe(false);
    await page.mouse.move(1, 1);
    await page.clock.fastForward(601000);
    await asleep();
    await quiet();
    await pet.click();
    await heard("welcome");
    await rest(); // no additional wake/pet clip
    await page.clock.fastForward(1000);
    await pet.click();
    await quiet();
    await page.clock.fastForward(6500);

    const startDrag = async () => {
      const box = await pet.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      return point;
    };
    const move = async () => {
      const p = await startDrag();
      await page.mouse.move(p.x + 30, p.y + 15);
      await expect(page.locator(".pet-stage")).toHaveClass(/is-dragging/);
      await page.mouse.up();
      await expect(page.locator(".pet-stage")).not.toHaveClass(/is-dragging/);
    };
    const jitter = await startDrag();
    await page.mouse.move(jitter.x + 2, jitter.y + 2);
    await page.mouse.up();
    await quiet();
    await move();
    await heard("moved");
    await rest();
    await move();
    await quiet(); // cooldown
    await page.clock.fastForward(31000);
    const cancelled = await startDrag();
    await page.mouse.move(cancelled.x + 20, cancelled.y + 10);
    await expect(page.locator(".pet-stage")).toHaveClass(/is-dragging/);
    await pet.dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    await quiet();
    await invoke("drag:start", { x: 100, y: 100 });
    await invoke("drag:move", { x: 120, y: 120 });
    await invoke("drag:move", { x: 100, y: 100 });
    assert.deepEqual(await invoke("drag:end"), { moved: false });
    await quiet();

    // The end IPC can settle after the renderer resumes. Expiry must start at
    // pointer-up, not at the later IPC reply; jump Date.now in the same JS task
    // so the reply cannot race ahead of this regression check.
    await page.clock.fastForward(31000);
    const delayed = await startDrag();
    await page.mouse.move(delayed.x + 20, delayed.y + 10);
    await expect(page.locator(".pet-stage")).toHaveClass(/is-dragging/);
    await pet.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
      );
      const at = Date.now();
      window.companionProbe.restoreNow = Date.now;
      Date.now = () => at + 6100;
    });
    await page.mouse.up();
    await invoke("state");
    try {
      await quiet();
    } finally {
      await page.evaluate(() => {
        Date.now = window.companionProbe.restoreNow;
        delete window.companionProbe.restoreNow;
      });
    }

    await page.mouse.move(1, 1);
    fixture.setStreamsAvailable(false);
    fixture.dropStreams();
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("reconnecting");
    await expect(pet.locator('[data-expression="sleeping"]')).toBeVisible();
    await page.clock.fastForward(11000);
    fixture.setStreamsAvailable(true);
    await expect
      .poll(async () => (await invoke("state")).connection, { timeout: 15000 })
      .toBe("connected");
    await expect(pet.locator('[data-expression="sleeping"]')).not.toBeVisible();
    await page.clock.fastForward(2000);
    await quiet();
    // Guarantee the real reconnect is delivered as one coalesced connected
    // snapshot, even on slower hosts where the 35 ms broadcast would split it.
    await app.evaluate(({ BrowserWindow }) => {
      const web = BrowserWindow.getAllWindows()[0].webContents;
      web.reviewSend = web.send;
      web.send = function (channel, ...args) {
        if (channel === "desktop:state") {
          web.reviewState = structuredClone(args[0]);
          return;
        }
        return web.reviewSend.call(web, channel, ...args);
      };
    });
    const oldEpoch = (await invoke("state")).connectionEpoch;
    await invoke("connect", fixture.endpoint);
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.reviewState
              ?.connection,
        ),
      )
      .toBe("connected");
    await app.evaluate(({ BrowserWindow }) => {
      const web = BrowserWindow.getAllWindows()[0].webContents;
      web.send = web.reviewSend;
      web.send("desktop:state", web.reviewState);
      delete web.reviewSend;
      delete web.reviewState;
    });
    await expect
      .poll(() => page.evaluate(() => window.companionProbe.epoch))
      .toBeGreaterThan(oldEpoch);
    await page.clock.fastForward(2000);
    // Timers installed before the mock clock still need a real tick to run.
    await page.waitForTimeout(1200);
    await quiet(); // the old recovery has reached 4 s, the new connection only 2 s
    await page.clock.fastForward(1100);
    await heard("reconnected");
    await rest();
    fixture.dropStreams(); // normal brief reconnect must stay silent
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    await page.clock.fastForward(5000);
    await quiet();

    await invoke("soundSettings", { sleep: true });
    await invoke("section", "settings");
    const settings = page.getByRole("region", { name: "声音设置" });
    await expect(settings.getByRole("switch")).toHaveCount(14);
    for (const [kind, label] of [
      ["shy", "害羞回应"],
      ["wake", "点击叫醒"],
      ["sleep", "准备睡觉"],
      ["welcome", "久别欢迎"],
      ["moved", "搬家回应"],
      ["reconnected", "重新连上"],
    ]) {
      await settings
        .getByRole("button", { name: `试听${label}`, exact: true })
        .click();
      await heard(kind);
      await rest();
      const toggle = settings.getByRole("switch", {
        name: `${label}声音`,
        exact: true,
      });
      await toggle.click();
      await expect(
        settings.getByRole("button", { name: `试听${label}`, exact: true }),
      ).toBeDisabled();
      await toggle.click();
      await expect(
        settings.getByRole("button", { name: `试听${label}`, exact: true }),
      ).toBeEnabled();
    }
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(data, "settings.json"), "utf8"))
            .sounds,
      )
      .toMatchObject({
        shy: true,
        wake: true,
        sleep: true,
        welcome: true,
        moved: true,
        reconnected: true,
      });
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.calls.some((call) => call.path === "/api/session.prompt"),
      false,
    );
    console.log(
      "Companion sounds passed: hover/shy cooldown, sleep transition, hover stays asleep, exclusive wake/welcome, real drag/jitter/cancel/origin and delayed-reply expiry, sustained and brief network recovery, stability reset for a coalesced new connection generation, six independent previews and persisted switches.",
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
