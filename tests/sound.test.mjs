import test from "node:test";
import assert from "node:assert/strict";
import {
  SOUND_DEFAULTS,
  normalizeSoundSettings,
  patchSoundSettings,
  SoundCues,
} from "../shared/sound.mjs";

const snapshot = () => ({
  connection: "connected",
  sessions: [
    { sessionId: "front", running: false },
    { sessionId: "back", running: false },
  ],
  pending: [],
  activity: {},
  completions: [],
  surface: { section: null },
  config: { expression: "auto" },
  lastInteractionAt: 1000,
});

test("sound settings retain zero and false, repair stored values and reject invalid IPC patches", () => {
  assert.deepEqual(normalizeSoundSettings(null), SOUND_DEFAULTS);
  assert.deepEqual(
    normalizeSoundSettings({
      enabled: false,
      volume: 0,
      pet: false,
      completion: false,
      idle: false,
    }),
    { enabled: false, volume: 0, pet: false, completion: false, idle: false },
  );
  assert.equal(normalizeSoundSettings({ volume: NaN }).volume, 35);
  assert.equal(normalizeSoundSettings({ volume: "90" }).volume, 35);
  assert.equal(normalizeSoundSettings({ volume: 200 }).volume, 100);
  assert.equal(normalizeSoundSettings({ volume: -1 }).volume, 0);
  assert.equal(
    patchSoundSettings({ volume: 70, pet: false }, { idle: false }).volume,
    70,
  );
  assert.equal(patchSoundSettings({ pet: false }, { volume: 0 }).pet, false);
  for (const patch of [
    null,
    [],
    {},
    { unknown: true },
    { enabled: 1 },
    { volume: "50" },
    { volume: -1 },
    { volume: Infinity },
    { volume: 101 },
  ])
    assert.throws(() => patchSoundSettings(null, patch), /无效声音设置/);
});

test("only fresh live ordinary completions sound, including hidden background tasks", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  state.completions = [{ id: "front:1", sessionId: "front", at: 1000 }];
  assert.deepEqual(cues.update(state, 1000), []);
  state.completions.push({ id: "back:2", sessionId: "back", at: 2000 });
  assert.deepEqual(cues.update(state, 2000, false), ["completion"]);
  assert.deepEqual(cues.update(state, 2100), []);
  state.connection = "reconnecting";
  state.completions.push({ id: "back:3", sessionId: "back", at: 2200 });
  assert.deepEqual(cues.update(state, 2200), []);
  state.connection = "connected";
  assert.deepEqual(cues.update(state, 2300), []);
  state.sessions.push({ sessionId: "child", origin: "subagent" });
  state.completions.push({ id: "child:1", sessionId: "child", at: 2400 });
  assert.deepEqual(cues.update(state, 2400), []);
  state.completions.push({ id: "front:4", sessionId: "front", at: 2500 });
  assert.deepEqual(cues.update(state, 9000), []);
});

test("idle greetings are sparse, reset on interaction and stop after falling asleep", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  assert.deepEqual(cues.update(state, 1000), []);
  assert.deepEqual(cues.update(state, 75999), []);
  assert.deepEqual(cues.update(state, 76000), ["idle"]);
  assert.deepEqual(cues.update(state, 77000), []);
  assert.deepEqual(cues.update(state, 195999), []);
  assert.deepEqual(cues.update(state, 196000), ["idle"]);
  assert.deepEqual(cues.update(state, 316000), []);
  cues.engage(320000);
  assert.deepEqual(cues.update(state, 394999), []);
  assert.deepEqual(cues.update(state, 395000), ["idle"]);
  state.lastInteractionAt = 400000;
  assert.deepEqual(cues.update(state, 470000), []);
  assert.deepEqual(cues.update(state, 475000), ["idle"]);
});

test("busy, pending, open, hidden, offline and pinned sleeping pets stay quiet, with no delayed greeting", () => {
  for (const setup of [
    (state) => (state.sessions[1].running = true),
    (state) => state.pending.push({ sessionId: "front", type: "question" }),
    (state) => (state.surface.section = "chat"),
    (state) => (state.config.expression = "sleeping"),
    (state) => (state.connection = "offline"),
  ]) {
    const cues = new SoundCues(1000, () => 0);
    const state = snapshot();
    cues.update(state, 1000);
    setup(state);
    assert.deepEqual(cues.update(state, 100000), []);
    assert.deepEqual(cues.update(snapshot(), 100001), []);
    assert.deepEqual(cues.update(snapshot(), 175000), ["idle"]);
  }
  const cues = new SoundCues(1000, () => 0);
  cues.update(snapshot(), 1000);
  assert.deepEqual(cues.update(snapshot(), 100000, false), []);
  assert.deepEqual(cues.update(snapshot(), 100001, true), []);
});
