import test from "node:test";
import assert from "node:assert/strict";
import {
  SOUND_DEFAULTS,
  normalizeSoundSettings,
  patchSoundSettings,
  SoundCues,
} from "../shared/sound.mjs";
import { DEFAULT_SOUND_VOICE, SOUND_VOICES } from "../shared/voices.mjs";
import { recordCompletion } from "../shared/completion.mjs";

const snapshot = () => ({
  connection: "connected",
  connectionEpoch: 1,
  sessions: [
    { sessionId: "front", running: false },
    { sessionId: "back", running: false },
  ],
  pending: [],
  activity: {},
  completions: [],
  surface: { section: null },
  config: { expression: "auto", endpoint: "http://127.0.0.1:3080" },
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
    {
      enabled: false,
      volume: 0,
      voice: DEFAULT_SOUND_VOICE,
      pet: false,
      angry: false,
      completion: false,
      idle: false,
      started: false,
      attention: true,
      failure: true,
      shy: false,
      wake: false,
      sleep: false,
      welcome: false,
      moved: false,
      reconnected: false,
    },
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
    { voice: "missing" },
    { voice: "../file" },
    { voice: 1 },
  ])
    assert.throws(() => patchSoundSettings(null, patch), /无效声音设置/);
});

test("anger inherits older touch-mute settings until explicitly configured", () => {
  assert.equal(normalizeSoundSettings({ pet: false }).angry, false);
  assert.equal(normalizeSoundSettings({ pet: true }).angry, true);
  assert.equal(normalizeSoundSettings({ angry: false }).angry, false);
  assert.equal(patchSoundSettings({ pet: false }, { angry: true }).angry, true);
  assert.equal(patchSoundSettings({}, { angry: false }).pet, true);
  assert.throws(() => patchSoundSettings({}, { angry: 1 }), /无效声音设置/);
});

test("voice choice survives patches and older or unknown settings use the default", () => {
  assert.equal(
    normalizeSoundSettings({ volume: 20 }).voice,
    DEFAULT_SOUND_VOICE,
  );
  assert.equal(
    normalizeSoundSettings({ voice: "removed-voice" }).voice,
    DEFAULT_SOUND_VOICE,
  );
  for (const { id } of SOUND_VOICES) {
    const settings = patchSoundSettings(
      { enabled: false, volume: 0 },
      { voice: id },
    );
    assert.equal(settings.voice, id);
    assert.equal(settings.enabled, false);
    assert.equal(settings.volume, 0);
    assert.equal(patchSoundSettings(settings, { pet: false }).voice, id);
  }
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

test("live completions wait for the session list and sound only once after it arrives", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  cues.update(state, 1000);
  state.completions.push({ id: "new:1", sessionId: "new", at: 2000 });
  assert.deepEqual(cues.update(state, 2000), []);
  assert.deepEqual(cues.update(state, 2100), []);
  state.sessions.push({ sessionId: "new", running: false });
  assert.deepEqual(cues.update(state, 2200, false), ["completion"]);
  assert.deepEqual(cues.update(state, 2300), []);
  state.sessions.pop();
  cues.update(state, 2400);
  state.sessions.push({ sessionId: "new", running: false });
  assert.deepEqual(cues.update(state, 2500), []);
});

test("initial, reconnecting, expired, muted and child completions are never revived by a late list", () => {
  for (const reason of [
    "initial",
    "reconnecting",
    "expired",
    "enabled",
    "volume",
    "completion",
    "child",
  ]) {
    const cues = new SoundCues(1000, () => 0);
    const state = snapshot();
    if (reason !== "initial") cues.update(state, 1000);
    state.completions.push({ id: "new:1", sessionId: "new", at: 2000 });
    assert.deepEqual(cues.update(state, 2000), []);
    if (reason === "reconnecting") state.connection = "reconnecting";
    if (["enabled", "volume", "completion"].includes(reason))
      state.config.sounds = { [reason]: reason === "volume" ? 0 : false };
    const now = reason === "expired" ? 8000 : 2100;
    assert.deepEqual(cues.update(state, now), []);
    state.connection = "connected";
    state.config.sounds = SOUND_DEFAULTS;
    state.sessions.push({
      sessionId: "new",
      ...(reason === "child" ? { origin: "subagent" } : {}),
    });
    assert.deepEqual(cues.update(state, now + 1), [], reason);
    // Expiry is consumed even if the clock moves backwards later.
    assert.deepEqual(cues.update(state, 2200), [], reason);
  }
});

test("pending completions disappear when removed from the incoming state", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  cues.update(state, 1000);
  state.completions.push({ id: "new:1", sessionId: "new", at: 2000 });
  cues.update(state, 2000);
  state.completions = [];
  cues.update(state, 2100);
  state.sessions.push({ sessionId: "new" });
  assert.deepEqual(cues.update(state, 2200), []);
  assert.equal(cues.seen.size, 0);
});

test("completion playback stays bound to its connection and original live event", () => {
  for (const change of [
    (state) => (state.connection = "reconnecting"),
    (state) => state.connectionEpoch++,
    (state) => (state.config.endpoint = "http://127.0.0.1:3081"),
    (state) => (state.completions = []),
    (state) => state.completions[0].at++,
    (state) =>
      (state.sessions = state.sessions.filter((s) => s.sessionId !== "back")),
    (state) => (state.sessions[1].origin = "subagent"),
  ]) {
    const cues = new SoundCues(1000, () => 0);
    const state = snapshot();
    cues.update(state, 1000);
    state.completions.push({ id: "back:1", sessionId: "back", at: 2000 });
    assert.deepEqual(cues.update(state, 2000), ["completion"]);
    const cue = cues.completionCue;
    assert.equal(cues.completionIsCurrent(state, 2100, cue), true);
    change(state);
    assert.equal(cues.completionIsCurrent(state, 2101, cue), false);
  }
});

test("a coalesced connection switch does not suppress a new completion with the same session and sequence", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  const event = {
    seq: 5,
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  };
  cues.update(state, 1000);
  state.completions = recordCompletion(
    [],
    "back",
    event,
    2000,
    state.connectionEpoch,
  );
  assert.deepEqual(cues.update(state, 2000), ["completion"]);
  const oldCue = cues.completionCue;
  // The renderer may never observe the empty connecting state between hosts.
  state.connectionEpoch++;
  state.completions = recordCompletion(
    [],
    "back",
    event,
    2000,
    state.connectionEpoch,
  );
  assert.equal(cues.completionIsCurrent(state, 2000, oldCue), false);
  assert.deepEqual(cues.update(state, 2000), ["completion"]);
  assert.equal(cues.completionIsCurrent(state, 2000, cues.completionCue), true);
  assert.deepEqual(cues.update(state, 2100), []);
});

test("background completion remains valid through selection, new turns and later policy ticks", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  cues.update(state, 1000);
  state.completions.push({ id: "back:1", sessionId: "back", at: 2000 });
  cues.update(state, 2000, false);
  const cue = cues.completionCue;
  state.selectedId = "front";
  state.sessions[1].running = true;
  state.surface.section = "settings";
  cues.update(state, 2100, false);
  assert.equal(cues.completionIsCurrent(state, 2200, cue), true);
  assert.equal(cues.completionIsCurrent(state, 1999, cue), false);
  assert.equal(cues.completionIsCurrent(state, 8000, cue), false);
});

test("a deferred completion captures its own event, not a newer already-consumed reminder", () => {
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  cues.update(state, 1000);
  state.completions.push({ id: "new:1", sessionId: "new", at: 2000 });
  cues.update(state, 2000);
  state.completions.push({ id: "back:1", sessionId: "back", at: 2100 });
  cues.update(state, 2100);
  assert.equal(cues.completionCue.id, "back:1");
  state.sessions.push({ sessionId: "new" });
  assert.deepEqual(cues.update(state, 2200), ["completion"]);
  assert.equal(cues.completionCue.id, "new:1");
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

test("idle playback expires on state changes and cannot revive after returning to idle", () => {
  for (const setup of [
    (state) => (state.sessions[1].running = true),
    (state) => state.pending.push({ sessionId: "front", type: "question" }),
    (state) => (state.surface.section = "settings"),
    (state) => (state.config.expression = "sleeping"),
    (state) => (state.connection = "offline"),
    (state) => (state.lastInteractionAt = 76001),
  ]) {
    const cues = new SoundCues(1000, () => 0);
    const state = snapshot();
    cues.update(state, 1000);
    assert.deepEqual(cues.update(state, 76000), ["idle"]);
    const revision = cues.idleRevision;
    assert.equal(cues.idleIsCurrent(state, 76000, true, revision), true);
    setup(state);
    // Playback sees fresh state even before the next policy tick.
    assert.equal(cues.idleIsCurrent(state, 76001, true, revision), false);
    cues.update(state, 76001);
    assert.equal(
      cues.idleIsCurrent(snapshot(), 76002, true, revision),
      false,
      "returning to idle must not restore an old greeting",
    );
  }
  const cues = new SoundCues(1000, () => 0);
  const state = snapshot();
  cues.update(state, 76000);
  const revision = cues.idleRevision;
  assert.equal(cues.idleIsCurrent(state, 76001, false, revision), false);
  cues.update(state, 76001, false);
  assert.equal(cues.idleIsCurrent(state, 76002, true, revision), false);
  assert.equal(
    cues.idleIsCurrent(state, 241000, true, cues.idleRevision),
    true,
  );
  assert.equal(
    cues.idleIsCurrent(state, 316001, true, cues.idleRevision),
    false,
  );
});
