import test from "node:test";
import assert from "node:assert/strict";
import { PetAudio } from "../src/sounds.ts";
import { SOUND_DEFAULTS } from "../shared/sound.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function audioHarness(
  t,
  fetchAudio = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  }),
  options = {},
) {
  const played = [];
  const requests = [];
  const signals = [];
  const gains = [];
  let decoded = 0;
  class AudioContext {
    state = options.state ?? "running";
    currentTime = 0;
    destination = {};
    createGain() {
      const gain = {
        gain: {
          value: 1,
          cancelAndHoldAtTime() {},
          linearRampToValueAtTime(value) {
            this.value = value;
          },
          cancelScheduledValues() {},
          setTargetAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
      gains.push(gain);
      return gain;
    }
    async decodeAudioData() {
      decoded++;
      if (options.decode) return options.decode();
      return { duration: 1 };
    }
    createBufferSource() {
      const source = {
        buffer: null,
        stopped: false,
        connect() {},
        disconnect() {},
        start() {
          played.push(source);
        },
        stop() {
          source.stopped = true;
          source.onended?.();
        },
      };
      return source;
    }
    async resume() {
      await options.resume?.();
      this.state = "running";
    }
    async close() {
      this.state = "closed";
    }
  }
  t.mock.method(globalThis, "fetch", (...args) => {
    requests.push(args[0]);
    signals.push(args[1]?.signal);
    return fetchAudio(...args);
  });
  const original = globalThis.AudioContext;
  globalThis.AudioContext = AudioContext;
  const audio = new PetAudio();
  t.after(() => {
    audio.dispose();
    if (original) globalThis.AudioContext = original;
    else delete globalThis.AudioContext;
  });
  return { audio, played, requests, signals, gains, decoded: () => decoded };
}

test("volume and unrelated switches preserve a loading completion at the updated gain", async (t) => {
  const loading = deferred();
  const { audio, played, gains } = audioHarness(t, () => loading.promise);
  const completion = audio.play("completion");
  audio.configure({ ...SOUND_DEFAULTS, volume: 70, pet: false, idle: false });
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "busy");
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "played");
  assert.equal(played.length, 1);
  assert.equal(gains[0].gain.value, 0.7);
});

test("disabling and re-enabling completion during loading never revives the old request", async (t) => {
  const loading = deferred();
  const { audio, played } = audioHarness(t, () => loading.promise);
  const completion = audio.play("completion");
  audio.configure({ ...SOUND_DEFAULTS, completion: false });
  audio.configure(SOUND_DEFAULTS);
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "muted");
  assert.equal(played.length, 0);
  assert.equal(await audio.play("completion"), "played");
});

test("hung fetch, body reads and decoding time out and allow a fresh cached retry", async (t) => {
  for (const stage of ["fetch", "body", "decode"]) {
    await t.test(stage, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const stalled = deferred();
      let attempts = 0;
      const holdOnce = (value) =>
        ++attempts === 1 ? stalled.promise : Promise.resolve(value);
      const response = () => ({
        ok: true,
        arrayBuffer: () =>
          stage === "body"
            ? holdOnce(new ArrayBuffer(8))
            : Promise.resolve(new ArrayBuffer(8)),
      });
      const { audio, played, requests, signals, decoded } = audioHarness(
        t,
        () =>
          stage === "fetch"
            ? holdOnce(response())
            : Promise.resolve(response()),
        stage === "decode" ? { decode: () => holdOnce({ duration: 1 }) } : {},
      );
      const pending = audio.preview(SOUND_VOICES[0].id);
      await new Promise(setImmediate); // Reach the blocked stage before advancing timers.
      t.mock.timers.tick(1000);
      assert.equal(await pending, "unavailable");
      assert.equal(signals[0].aborted, true);
      assert.equal(played.length, 0);
      assert.equal(await audio.preview(SOUND_VOICES[0].id), "played");
      assert.equal(
        requests.length,
        2,
        "retry fetches again instead of reusing a hung promise",
      );
      if (stage === "fetch")
        stalled.reject(new Error("late old fetch failure"));
      else
        stalled.resolve(
          stage === "body" ? new ArrayBuffer(8) : { duration: 2 },
        );
      await new Promise(setImmediate);
      assert.equal(played.length, 1, "late settlement cannot start old audio");
      const decodedBefore = decoded();
      t.mock.timers.tick(1000);
      assert.equal(
        signals[1].aborted,
        false,
        "successful loads clear their timeout",
      );
      assert.equal(await audio.preview(SOUND_VOICES[0].id), "played");
      assert.equal(
        requests.length,
        2,
        "late settlement cannot evict the successful retry",
      );
      assert.equal(decoded(), decodedBefore);
    });
  }
});

test("a stalled output resume times out without discarding a decoded clip", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = deferred();
  let attempts = 0;
  const { audio, played, requests, decoded } = audioHarness(t, undefined, {
    state: "suspended",
    resume: () => (++attempts === 1 ? stalled.promise : Promise.resolve()),
  });
  const pending = audio.preview(SOUND_VOICES[0].id);
  await new Promise(setImmediate);
  assert.equal(decoded(), 1);
  t.mock.timers.tick(1000);
  assert.equal(await pending, "unavailable");
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "played");
  assert.equal(requests.length, 1);
  assert.equal(decoded(), 1);
  stalled.resolve();
  await new Promise(setImmediate);
  assert.equal(played.length, 1);
});

test("disposal aborts and settles a hanging load immediately", async (t) => {
  const stalled = deferred();
  const { audio, signals, played } = audioHarness(t, () => stalled.promise);
  const pending = audio.play("completion");
  audio.dispose();
  assert.equal(await pending, "muted");
  assert.equal(signals[0].aborted, true);
  assert.equal(played.length, 0);
});

test("voice changes discard in-flight audio and stop the previous voice", async (t) => {
  const loading = deferred();
  const { audio, played, requests } = audioHarness(t, () => loading.promise);
  const pending = audio.play("pet");
  audio.configure({ ...SOUND_DEFAULTS, voice: SOUND_VOICES[1].id });
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await pending, "muted");
  assert.equal(played.length, 0);
  assert.equal(await audio.play("pet"), "played");
  assert.ok(requests[1].includes(SOUND_VOICES[1].id));
  audio.configure({ ...SOUND_DEFAULTS, voice: SOUND_VOICES[2].id });
  assert.equal(played[0].stopped, true);
});

test("muting, disabling an event or disposal during loading never starts delayed playback", async (t) => {
  for (const action of [
    (audio) => audio.configure({ ...SOUND_DEFAULTS, enabled: false }),
    (audio) => audio.configure({ ...SOUND_DEFAULTS, volume: 0 }),
    (audio) => audio.configure({ ...SOUND_DEFAULTS, pet: false }),
    (audio) => audio.dispose(),
  ]) {
    await t.test(async (t) => {
      const loading = deferred();
      const { audio, played } = audioHarness(t, () => loading.promise);
      const pending = audio.play("pet");
      action(audio);
      loading.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
      assert.notEqual(await pending, "played");
      assert.equal(played.length, 0);
    });
  }
});

test("failed loads are retryable; repeated previews reuse decoded audio and replace playback", async (t) => {
  let attempts = 0;
  const { audio, played, decoded, requests } = audioHarness(t, async () => {
    attempts++;
    return { ok: attempts > 1, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  audio.configure({
    ...SOUND_DEFAULTS,
    pet: false,
    completion: false,
    idle: false,
  });
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "unavailable");
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "played");
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "played");
  assert.equal(attempts, 2);
  assert.equal(decoded(), 1);
  assert.equal(played[0].stopped, true);
  assert.equal(played[1].stopped, false);
  assert.ok(requests.every((url) => url.startsWith("./voices/")));
  audio.configure({ ...SOUND_DEFAULTS, enabled: false });
  assert.equal(played[1].stopped, true);
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "muted");
  assert.equal(await audio.preview("../unknown"), "unavailable");
});

test("a loading or playing completion cannot be replaced by pet, idle or preview requests", async (t) => {
  const loading = deferred();
  const { audio, played, requests } = audioHarness(t, () => loading.promise);
  const completion = audio.play("completion");
  assert.equal(await audio.play("pet"), "busy");
  assert.equal(await audio.play("idle"), "busy");
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "busy");
  assert.equal(await audio.play("completion"), "busy");
  assert.equal(requests.length, 1, "coalesced requests do not start new loads");
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "played");
  assert.equal(await audio.preview(SOUND_VOICES[0].id), "busy");
  assert.equal(await audio.play("pet"), "busy");
  assert.equal(played.length, 1);
  assert.equal(played[0].stopped, false);
  played[0].onended();
  assert.equal(await audio.play("pet"), "played");
});

test("completion preempts a loading pet and remains reserved when the old load finishes", async (t) => {
  const petLoad = deferred();
  const completionLoad = deferred();
  const { audio, played } = audioHarness(t, (url) =>
    url.endsWith("/pet.wav") ? petLoad.promise : completionLoad.promise,
  );
  const pet = audio.play("pet");
  const completion = audio.play("completion");
  petLoad.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await pet, "muted");
  assert.equal(await audio.play("pet"), "busy");
  completionLoad.resolve({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  assert.equal(await completion, "played");
  assert.equal(played.length, 1);
});

test("completion cancels a stalled audition without reporting its eventual timeout or failure", async (t) => {
  for (const stage of ["fetch", "body", "decode", "resume"]) {
    await t.test(stage, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const stalled = deferred();
      let decoded = 0;
      let resumed = 0;
      const { audio, played, signals } = audioHarness(
        t,
        async (url) => {
          const preview = url.endsWith("/preview.wav");
          if (preview && stage === "fetch") return stalled.promise;
          return {
            ok: true,
            arrayBuffer: () =>
              preview && stage === "body"
                ? stalled.promise
                : Promise.resolve(new ArrayBuffer(8)),
          };
        },
        {
          state: stage === "resume" ? "suspended" : "running",
          decode: () =>
            ++decoded === 1 && stage === "decode"
              ? stalled.promise
              : Promise.resolve({ duration: 1 }),
          resume: () => (++resumed === 1 ? stalled.promise : Promise.resolve()),
        },
      );
      const audition = audio.preview(SOUND_VOICES[0].id);
      await new Promise(setImmediate);
      const completion = audio.play("completion");
      assert.equal(await audition, "muted", "preemption settles immediately");
      assert.equal(await completion, "played");
      t.mock.timers.tick(1000);
      stalled.reject(new Error(`late ${stage} failure`));
      await new Promise(setImmediate);
      assert.equal(played.length, 1);
      assert.equal(played[0].stopped, false);
      assert.equal(signals[1].aborted, false, "the completion stays cached");
    });
  }
});

test("preempting an audition can reuse its in-flight clip without cancelling the shared load", async (t) => {
  const loading = deferred();
  const { audio, signals, played, requests } = audioHarness(
    t,
    () => loading.promise,
  );
  const audition = audio.preview(SOUND_VOICES[0].id, "completion");
  const completion = audio.play("completion");
  assert.equal(await audition, "muted");
  assert.equal(signals[0].aborted, false);
  assert.equal(requests.length, 1);
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "played");
  assert.equal(played.length, 1);
});

test("invalidating an automatic completion releases priority for the new connection", async (t) => {
  const loading = deferred();
  const { audio, played, requests } = audioHarness(t, () => loading.promise);
  let epoch = 1;
  const old = audio.play("completion", () => epoch === 1);
  epoch = 2;
  audio.refresh();
  assert.equal(await old, "muted");
  const current = audio.play("completion", () => epoch === 2);
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await current, "played");
  assert.equal(played.length, 1);
  assert.equal(
    requests.length,
    1,
    "connection changes do not discard offline assets",
  );
});

test("releasing overdue priority does not disguise a real playback timeout as cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { audio } = audioHarness(t, (url) =>
    url.endsWith("/preview.wav")
      ? new Promise(() => {})
      : Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        }),
  );
  const audition = audio.preview(SOUND_VOICES[0].id);
  now = 1001;
  audio.refresh();
  assert.equal(await audio.play("completion"), "played");
  t.mock.timers.tick(1000);
  assert.equal(await audition, "unavailable");
});

test("failed completion loads release their playback reservation", async (t) => {
  let attempts = 0;
  const { audio } = audioHarness(t, async () => ({
    ok: ++attempts > 1,
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
  assert.equal(await audio.play("completion"), "unavailable");
  assert.equal(await audio.play("pet"), "played");
  audio.configure({ ...SOUND_DEFAULTS, enabled: false });
  audio.configure(SOUND_DEFAULTS);
  assert.equal(await audio.play("completion"), "played");
});

test("changing voice releases a pending completion without letting the old load play", async (t) => {
  const loading = deferred();
  const { audio, played } = audioHarness(t, (url) =>
    url.endsWith("/completion.wav")
      ? loading.promise
      : Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        }),
  );
  const completion = audio.play("completion");
  audio.configure({ ...SOUND_DEFAULTS, voice: SOUND_VOICES[1].id });
  assert.equal(await audio.play("pet"), "played");
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "muted");
  assert.equal(played.length, 1);
});

test("an overdue completion load cannot keep blocking other sounds", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const loading = deferred();
  const { audio, played } = audioHarness(t, (url) =>
    url.endsWith("/completion.wav")
      ? loading.promise
      : Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        }),
  );
  const completion = audio.play("completion");
  now = 1001;
  assert.equal(await audio.play("pet"), "played");
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await completion, "unavailable");
  assert.equal(
    played.length,
    1,
    "the late completion does not interrupt the pet",
  );
});

test("automatic idle audio rechecks eligibility after loading", async (t) => {
  const loading = deferred();
  const { audio, played } = audioHarness(t, () => loading.promise);
  let eligible = true;
  const idle = audio.play("idle", () => eligible);
  eligible = false;
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await idle, "muted");
  assert.equal(played.length, 0);
  // The settings page must still be able to audition this clip manually.
  assert.equal(await audio.preview(SOUND_VOICES[0].id, "idle"), "played");
});

test("manual cue previews repeat immediately and neither consume nor obey automatic cooldowns", async (t) => {
  for (const kind of ["pet", "completion", "idle"]) {
    await t.test(kind, async (t) => {
      const { audio, played } = audioHarness(t);
      const voice = SOUND_VOICES[0].id;
      assert.equal(await audio.preview(voice, kind), "played");
      assert.equal(await audio.preview(voice, kind), "played");
      assert.equal(
        played[0].stopped,
        true,
        "a new audition replaces the old sound",
      );
      played.at(-1).onended();
      assert.equal(
        await audio.play(kind),
        "played",
        "auditions do not consume the event cooldown",
      );
      played.at(-1).onended();
      assert.equal(
        await audio.play(kind),
        "busy",
        "automatic events retain their cooldown",
      );
      assert.equal(
        await audio.preview(voice, kind),
        "played",
        "manual audition bypasses that cooldown",
      );
    });
  }
});

test("real completion preempts even a completion audition and retains its priority", async (t) => {
  for (const stage of ["loading", "playing"]) {
    await t.test(stage, async (t) => {
      const loading = deferred();
      const { audio, played } = audioHarness(
        t,
        stage === "loading" ? () => loading.promise : undefined,
      );
      const audition = audio.preview(SOUND_VOICES[0].id, "completion");
      if (stage === "playing") assert.equal(await audition, "played");
      const actual = audio.play("completion");
      let accepted = false;
      assert.equal(
        await audio.preview(SOUND_VOICES[0].id, "idle", () => {
          accepted = true;
        }),
        "busy",
      );
      assert.equal(
        accepted,
        false,
        "a rejected audition must not replace the UI request",
      );
      if (stage === "loading") {
        loading.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        });
        assert.equal(await audition, "muted");
      }
      assert.equal(await actual, "played");
      if (stage === "playing") assert.equal(played[0].stopped, true);
      assert.equal(
        await audio.preview(SOUND_VOICES[0].id, "completion"),
        "busy",
      );
    });
  }
});

test("only accepted auditions claim their UI request, including accepted failures", async (t) => {
  const { audio } = audioHarness(t, async () => ({ ok: false }));
  let accepted = 0;
  const claim = () => {
    accepted++;
  };
  audio.configure({ ...SOUND_DEFAULTS, idle: false });
  assert.equal(await audio.preview(SOUND_VOICES[0].id, "idle", claim), "muted");
  assert.equal(accepted, 0);
  assert.equal(
    await audio.preview(SOUND_VOICES[0].id, "preview", claim),
    "unavailable",
  );
  assert.equal(accepted, 1);
});

test("invalidated idle loads do not revive after eligibility returns", async (t) => {
  const loading = deferred();
  const { audio, played } = audioHarness(t, () => loading.promise);
  let eligible = true;
  const idle = audio.play("idle", () => eligible);
  eligible = false;
  audio.refresh();
  eligible = true;
  loading.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await idle, "muted");
  assert.equal(played.length, 0);
  assert.equal(await audio.play("idle", () => eligible), "played");
  eligible = false;
  audio.refresh();
  assert.equal(played[0].stopped, true, "active automatic greetings also stop");
});
