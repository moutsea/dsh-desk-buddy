import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";
import { holdResponse } from "../tests/helpers/held-response.mjs";

export async function checkSoundRaces() {
  const fixture = await createFixture();
  fixture.sessions.set("race", {
    sessionId: "race",
    title: "Audio race",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  const other = await createFixture();
  other.sessions.set("race", {
    ...fixture.sessions.get("race"),
    title: "Other connection",
    events: [],
  });
  const data = await mkdtemp(join(tmpdir(), "dsg-sound-races-"));
  const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        selectedId: "race",
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
    await page.evaluate(() => {
      window.raceProbe = {
        starts: [],
        decoded: 0,
        requestedAt: 0,
        decodeElapsed: 0,
        blocked: null,
        release: null,
        lastSignal: null,
        timedOutRelease: null,
        active: 0,
        output: null,
      };
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        createGain() {
          const gain = super.createGain();
          window.raceProbe.output ??= gain;
          return gain;
        }
        async decodeAudioData(data) {
          const buffer = await super.decodeAudioData(data);
          window.raceProbe.decoded++;
          window.raceProbe.decodeElapsed =
            performance.now() - window.raceProbe.requestedAt;
          return buffer;
        }
        createBufferSource() {
          const source = super.createBufferSource();
          const start = source.start.bind(source);
          source.start = (...args) => {
            window.raceProbe.active++;
            window.raceProbe.starts.push(source.buffer.duration);
            return start(...args);
          };
          source.addEventListener("ended", () => window.raceProbe.active--);
          return source;
        }
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        if (String(args[0]).endsWith(`/${window.raceProbe.blocked}.wav`)) {
          window.raceProbe.requestedAt = performance.now();
          window.raceProbe.lastSignal = args[1]?.signal;
          await new Promise((resolve) => {
            window.raceProbe.release = resolve;
          });
        }
        return nativeFetch(...args);
      };
    });
    const hold = (kind) =>
      page.evaluate((kind) => {
        window.raceProbe.blocked = kind;
        window.raceProbe.release = null;
      }, kind);
    const release = () =>
      page.evaluate(() => {
        window.raceProbe.blocked = null;
        window.raceProbe.release();
      });
    const starts = () => page.evaluate(() => window.raceProbe.starts);

    await hold("completion");
    fixture.event("race", "turn/start", {});
    fixture.event("race", "turn/end", { reason: { kind: "completed" } });
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    await invoke("soundSettings", { volume: 70 });
    await expect
      .poll(() =>
        page.evaluate(() => Math.abs(window.raceProbe.output.gain.value - 0.7)),
      )
      .toBeLessThan(0.001);
    await page
      .getByRole("button", { name: "摸摸桌宠", exact: true })
      .dispatchEvent("click");
    await release();
    await expect.poll(starts).toEqual([0.72]); // completion.wav, not the 1.2s pet.wav
    await page.waitForTimeout(1300);

    await invoke("section", "settings");
    const preview = page.getByRole("button", {
      name: "试听当前声线",
      exact: true,
    });
    const playbackError = page
      .getByRole("alert")
      .filter({ hasText: "暂时无法播放声音" });
    await hold("preview");
    await preview.click();
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    await expect(playbackError).toBeVisible();
    assert.equal(
      await page.evaluate(() => window.raceProbe.lastSignal.aborted),
      true,
    );
    assert.deepEqual(await starts(), [0.72]);
    await page.evaluate(() => {
      window.raceProbe.timedOutRelease = window.raceProbe.release;
    });
    await hold("preview");
    await preview.click();
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    // Settle the old failed request while its replacement is loading.
    await page.evaluate(() => window.raceProbe.timedOutRelease());
    await release();
    await expect.poll(async () => (await starts()).length).toBe(2);
    await expect(playbackError).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);
    const voice = page.getByLabel("声线", { exact: true });
    // A superseded load may fail after the new voice has already started.
    // Cover both preview handlers and a same-voice switch between cue types.
    for (const [oldVoice, newVoice, kind, label] of [
      [1, 2, "preview", "试听当前声线"],
      [3, 4, "idle", "试听无聊时打招呼"],
      [5, 5, "idle", "试听无聊时打招呼"],
    ]) {
      await voice.selectOption(SOUND_VOICES[oldVoice].id);
      await hold(kind);
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction(
        () => typeof window.raceProbe.release === "function",
      );
      await page.evaluate(() => {
        window.raceProbe.blocked = null;
      });
      if (newVoice !== oldVoice)
        await voice.selectOption(SOUND_VOICES[newVoice].id);
      const before = (await starts()).length;
      await preview.click();
      await expect.poll(async () => (await starts()).length).toBe(before + 1);
      await expect
        .poll(() => page.evaluate(() => window.raceProbe.lastSignal.aborted))
        .toBe(true);
      await expect(playbackError).toHaveCount(0);
      await release();
      await expect
        .poll(() => page.evaluate(() => window.raceProbe.active))
        .toBe(0);
      await expect(playbackError).toHaveCount(0);
    }
    // Automatic completion has no audition UI request of its own. Cancelling
    // the preview must therefore settle harmlessly inside the audio engine.
    await voice.selectOption(SOUND_VOICES[7].id);
    const beforePreemption = (await starts()).length;
    await hold("preview");
    await preview.click();
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    fixture.event("race", "turn/start", {});
    fixture.event("race", "turn/end", { reason: { kind: "completed" } });
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforePreemption + 1);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.lastSignal.aborted))
      .toBe(true);
    await release();
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);
    await expect(playbackError).toHaveCount(0);
    assert.equal((await starts()).length, beforePreemption + 1);

    await voice.selectOption(SOUND_VOICES[0].id);
    fixture.sessions.set("arriving", {
      sessionId: "arriving",
      title: "New arrival",
      running: false,
      blank: false,
      updatedAt: Date.now(),
      events: [],
    });
    const heldList = await holdResponse(app, "/api/session.list");
    fixture.push("host", {
      type: "host/session-added",
      sessionId: "arriving",
    });
    await heldList.wait();
    const beforeArrival = (await starts()).length;
    fixture.event("arriving", "turn/start", {});
    fixture.event("arriving", "turn/end", { reason: { kind: "completed" } });
    await expect
      .poll(async () =>
        (await invoke("state")).completions.some(
          (item) => item.sessionId === "arriving",
        ),
      )
      .toBe(true);
    assert.equal(
      (await invoke("state")).sessions.some(
        (item) => item.sessionId === "arriving",
      ),
      false,
    );
    await page.waitForTimeout(200); // Let the renderer observe the missing row.
    assert.equal((await starts()).length, beforeArrival);
    await heldList.release();
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforeArrival + 1);
    await invoke("refresh");
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);
    assert.equal((await starts()).length, beforeArrival + 1);

    await voice.selectOption(SOUND_VOICES[6].id);
    const manualIdle = page.getByRole("button", {
      name: "试听无聊时打招呼",
      exact: true,
    });
    const beforeAuditions = (await starts()).length;
    await manualIdle.click();
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforeAuditions + 1);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);
    await manualIdle.click();
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforeAuditions + 2);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);

    const manualCompletion = page.getByRole("button", {
      name: "试听任务完成",
      exact: true,
    });
    await hold("completion");
    await manualCompletion.click();
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    await manualCompletion.click();
    await expect(playbackError).toBeVisible();
    assert.equal(
      await page.evaluate(() => window.raceProbe.lastSignal.aborted),
      true,
    );
    await release();
    await manualCompletion.click();
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforeAuditions + 3);
    await expect(playbackError).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);

    // Cancel pending automatic cues across endpoint switches, explicit
    // reconnection to the same endpoint, and a transient stream disconnection.
    let currentFixture = fixture;
    for (const [voiceIndex, action] of [
      [1, "switch"],
      [2, "reconnect"],
      [4, "disconnect"],
    ]) {
      await voice.selectOption(SOUND_VOICES[voiceIndex].id);
      const before = (await starts()).length;
      const decoded = await page.evaluate(() => window.raceProbe.decoded);
      const epoch = (await invoke("state")).connectionEpoch;
      await hold("completion");
      currentFixture.event("race", "turn/start", {});
      currentFixture.event("race", "turn/end", {
        reason: { kind: "completed" },
      });
      await page.waitForFunction(
        () => typeof window.raceProbe.release === "function",
      );
      if (action === "disconnect") {
        other.dropStreams();
        await expect
          .poll(async () => (await invoke("state")).connection)
          .toBe("reconnecting");
      } else {
        await invoke("connect", other.endpoint);
        currentFixture = other;
      }
      assert.ok((await invoke("state")).connectionEpoch > epoch);
      await page.waitForTimeout(75); // Deliver the new state to the renderer.
      await release();
      await expect
        .poll(() => page.evaluate(() => window.raceProbe.decoded))
        .toBe(decoded + 1);
      assert.ok(
        await page.evaluate(() => window.raceProbe.decodeElapsed < 1000),
        "the cue is cancelled by connection identity, not by its loading deadline",
      );
      assert.equal((await starts()).length, before, action);
      await expect
        .poll(async () => (await invoke("state")).connection)
        .toBe("connected");
      assert.deepEqual(
        (await invoke("state")).completions,
        [],
        "a reconnected stream cannot revive reminders from the old connection",
      );
      // The cancelled reservation and its decoded buffer must remain usable.
      other.event("race", "turn/start", {});
      other.event("race", "turn/end", { reason: { kind: "completed" } });
      await expect.poll(async () => (await starts()).length).toBe(before + 1);
      await expect
        .poll(() => page.evaluate(() => window.raceProbe.active))
        .toBe(0);
    }

    await invoke("connect", fixture.endpoint);
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    await voice.selectOption(SOUND_VOICES[3].id);
    const beforeSelection = (await starts()).length;
    await hold("completion");
    fixture.event("race", "turn/start", {});
    fixture.event("race", "turn/end", { reason: { kind: "completed" } });
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    await invoke("select", "arriving");
    await release();
    await expect
      .poll(async () => (await starts()).length)
      .toBe(beforeSelection + 1);
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.active))
      .toBe(0);

    await voice.selectOption(SOUND_VOICES[0].id);
    const beforeIdle = await starts();
    const decodedBeforeIdle = await page.evaluate(
      () => window.raceProbe.decoded,
    );
    await invoke("section", null);

    await page.clock.install();
    await page.clock.fastForward(15000);
    await page.mouse.move(1, 1);
    await hold("idle");
    await invoke("engage");
    await page.clock.fastForward(110000);
    await page.waitForFunction(
      () => typeof window.raceProbe.release === "function",
    );
    await invoke("section", "settings");
    await expect(page.locator(".companion-surface")).toHaveAttribute(
      "data-section",
      "settings",
    );
    // Even closing the panel before the load finishes must not revive the request.
    await invoke("section", null);
    await expect(page.locator(".companion-surface")).not.toHaveAttribute(
      "data-section",
    );
    await release();
    await expect
      .poll(() => page.evaluate(() => window.raceProbe.decoded))
      .toBe(decodedBeforeIdle + 1);
    const elapsed = await page.evaluate(() => window.raceProbe.decodeElapsed);
    assert.ok(
      elapsed < 1000,
      "cancellation must not merely rely on the 1s load deadline",
    );
    assert.deepEqual(
      await starts(),
      beforeIdle,
      "the cancelled idle cue never starts",
    );

    await invoke("section", "settings");
    await page
      .getByRole("button", { name: "试听无聊时打招呼", exact: true })
      .click();
    await expect.poll(starts).toEqual([...beforeIdle, 1.28]);
    assert.deepEqual(errors, []);
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/sound-races-result.json",
      JSON.stringify(
        {
          completionSurvivesPetDuringLoad: true,
          completionSurvivesVolumeChangeDuringLoad: true,
          stalledPreviewReportsErrorAndAborts: true,
          previewRetryLoadsAndPlays: true,
          lateFailedLoadDoesNotEvictRetry: true,
          oldPreviewFailureCannotOverwriteNewVoice: true,
          oldCueFailureCannotOverwriteNewPreview: true,
          manualIdleRepeatsWithoutCooldown: true,
          repeatedCompletionPreviewStillReportsFailure: true,
          automaticCompletionCancelsPreviewWithoutError: true,
          completionBeforeSessionListPlaysOnceAfterArrival: true,
          oldCompletionCancelledAcrossConnections: true,
          oldCompletionCancelledOnSameEndpointReconnect: true,
          oldCompletionCancelledOnStreamDisconnection: true,
          newConnectionCompletionStillPlays: true,
          pendingBackgroundCompletionSurvivesSessionSelection: true,
          idleCancelledWhenPanelOpens: true,
          idleDoesNotReviveWhenPanelCloses: true,
          manualIdlePreviewWorks: true,
          idleLoadElapsedMs: elapsed,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Sound races passed: completion priority and volume changes, preview timeout/abort/retry, stale-request isolation, automatic preemption without false errors, completion before session-list arrival, pending completion cancellation across connections and reconnects, preserved background reminders, repeatable manual cues, double-click failure feedback, idle cancellation without revival.",
    );
  } finally {
    await app?.close();
    await fixture.close();
    await other.close();
    await rm(data, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
