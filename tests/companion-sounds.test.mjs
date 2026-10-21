import test from "node:test";
import assert from "node:assert/strict";
import {
  GreetingCues,
  ReconnectionCues,
  WELCOME_AFTER,
  RECONNECT_AFTER,
  RECONNECT_STABLE,
} from "../shared/companion-sounds.mjs";
import {
  SOUND_DEFAULTS,
  normalizeSoundSettings,
  patchSoundSettings,
  SoundCues,
} from "../shared/sound.mjs";

const sounds = { ...SOUND_DEFAULTS, reconnected: true };
const snapshot = () => ({
  connection: "connected",
  connectionEpoch: 1,
  config: { endpoint: "local", sounds },
  sessions: [],
  activity: {},
  pending: [],
  surface: { section: null },
});

test("a pointer press remembers sleep, and welcome wins without a second greeting", () => {
  const cue = new GreetingCues(1000);
  cue.prepare(true, 2000);
  assert.equal(cue.click(false, true, sounds, 2100), "wake");
  assert.equal(cue.click(false, true, sounds, 2200), null);
  cue.prepare(true, 2200 + WELCOME_AFTER);
  assert.equal(cue.click(false, true, sounds, 2300 + WELCOME_AFTER), "welcome");
  assert.equal(
    cue.click(
      true,
      true,
      { ...sounds, welcome: false },
      2300 + WELCOME_AFTER * 2,
    ),
    "wake",
  );
});

test("greetings consume muted, ineligible and cancelled interactions without replay", () => {
  for (const [eligible, overrides] of [
    [false, {}],
    [true, { enabled: false }],
    [true, { volume: 0 }],
    [true, { welcome: false, wake: false }],
  ]) {
    const cue = new GreetingCues(0);
    assert.equal(
      cue.click(true, eligible, { ...sounds, ...overrides }, WELCOME_AFTER),
      null,
    );
    assert.equal(cue.click(false, true, sounds, WELCOME_AFTER + 1), null);
  }
  const cue = new GreetingCues(1000);
  cue.prepare(true, WELCOME_AFTER + 1000);
  cue.engage(WELCOME_AFTER + 1001);
  assert.equal(cue.click(false, true, sounds, WELCOME_AFTER + 1002), null);
  assert.equal(
    cue.click(false, true, sounds, 1),
    null,
    "clock reversal is not an absence",
  );
});

test("companion switches preserve prior touch mute and remain independently configurable", () => {
  const migrated = normalizeSoundSettings({ pet: false });
  for (const kind of ["shy", "wake", "welcome"])
    assert.equal(migrated[kind], false);
  for (const kind of [
    "shy",
    "wake",
    "sleep",
    "welcome",
    "moved",
    "reconnected",
  ]) {
    assert.equal(patchSoundSettings(migrated, { [kind]: true })[kind], true);
    assert.throws(() => patchSoundSettings({}, { [kind]: 1 }));
  }
});

function outage() {
  const cue = new ReconnectionCues(),
    state = snapshot();
  assert.equal(cue.update(state, 0, true, sounds), false);
  state.connection = "reconnecting";
  state.connectionEpoch++;
  cue.update(state, 1000, true, sounds);
  state.connection = "connected";
  return { cue, state, recoveredAt: 1000 + RECONNECT_AFTER };
}

test("recovery requires an observed long outage followed by continuous stability", () => {
  const { cue, state, recoveredAt } = outage();
  assert.equal(cue.update(state, recoveredAt, true, sounds), false);
  assert.equal(
    cue.update(state, recoveredAt + RECONNECT_STABLE - 1, true, sounds),
    false,
  );
  assert.equal(
    cue.update(state, recoveredAt + RECONNECT_STABLE, true, sounds),
    true,
  );
  const binding = cue.cue;
  assert.equal(
    cue.isCurrent(state, recoveredAt + RECONNECT_STABLE, true, binding),
    true,
  );
  assert.equal(
    cue.update(state, recoveredAt + RECONNECT_STABLE + 1, true, sounds),
    false,
  );
  assert.equal(
    cue.isCurrent(
      { ...state, connectionEpoch: 99 },
      recoveredAt + RECONNECT_STABLE,
      true,
      binding,
    ),
    false,
  );
  assert.equal(
    cue.isCurrent(state, recoveredAt + RECONNECT_STABLE + 6000, true, binding),
    false,
  );
});

test("initial connections, endpoint changes, short flaps and clock reversal stay quiet", () => {
  const initial = new ReconnectionCues();
  const initialState = snapshot();
  initialState.connection = "offline";
  initial.update(initialState, 0, true, sounds);
  initialState.connection = "connected";
  assert.equal(initial.update(initialState, 60000, true, sounds), false);
  assert.equal(initial.update(initialState, 64000, true, sounds), false);
  for (const scenario of ["endpoint", "short", "clock"]) {
    const { cue, state, recoveredAt } = outage();
    if (scenario === "endpoint") state.config.endpoint = "other";
    const time =
      scenario === "short"
        ? recoveredAt - 1
        : scenario === "clock"
          ? 999
          : recoveredAt;
    assert.equal(cue.update(state, time, true, sounds), false);
    assert.equal(
      cue.update(state, time + RECONNECT_STABLE, true, sounds),
      false,
      scenario,
    );
  }
});

test("coalesced connected generations must each complete a fresh stability interval", () => {
  const { cue, state, recoveredAt } = outage();
  cue.update(state, recoveredAt, true, sounds);
  state.connectionEpoch++;
  const restartedAt = recoveredAt + 1500;
  assert.equal(cue.update(state, restartedAt, true, sounds), false);
  assert.equal(
    cue.update(state, recoveredAt + RECONNECT_STABLE, true, sounds),
    false,
  );
  assert.equal(
    cue.update(state, restartedAt + RECONNECT_STABLE - 1, true, sounds),
    false,
  );
  assert.equal(
    cue.update(state, restartedAt + RECONNECT_STABLE, true, sounds),
    true,
  );
  assert.equal(cue.cue.connectionEpoch, state.connectionEpoch);
  const binding = cue.cue;
  state.connectionEpoch++;
  assert.equal(
    cue.isCurrent(state, restartedAt + RECONNECT_STABLE, true, binding),
    false,
  );
  assert.equal(
    cue.update(state, restartedAt + RECONNECT_STABLE + 1, true, sounds),
    false,
  );
  assert.equal(
    cue.update(state, restartedAt + RECONNECT_STABLE * 2, true, sounds),
    false,
  );
});

test("a generation change cannot revive an expired or suppressed recovery", () => {
  for (const reason of ["expired", "hidden", "muted", "clock"]) {
    const { cue, state, recoveredAt } = outage();
    cue.update(state, recoveredAt, reason !== "hidden", {
      ...sounds,
      enabled: reason !== "muted",
    });
    state.connectionEpoch++;
    const now =
      reason === "expired"
        ? recoveredAt + 9000
        : reason === "clock"
          ? recoveredAt - 1
          : recoveredAt + 1500;
    assert.equal(cue.update(state, now, true, sounds), false, reason);
    assert.equal(
      cue.update(state, now + RECONNECT_STABLE, true, sounds),
      false,
      reason,
    );
  }
  const cue = new ReconnectionCues(),
    state = snapshot();
  cue.update(state, 0, true, sounds);
  state.connectionEpoch++;
  assert.equal(cue.update(state, 1000, true, sounds), false);
  assert.equal(cue.update(state, 1000 + RECONNECT_STABLE, true, sounds), false);
});

test("generation changes during an observed outage do not shorten its measured duration", () => {
  const { cue, state, recoveredAt } = outage();
  state.connection = "reconnecting";
  state.connectionEpoch++;
  cue.update(state, recoveredAt - 1000, true, sounds);
  state.connectionEpoch++;
  state.connection = "connected";
  assert.equal(cue.update(state, recoveredAt, true, sounds), false);
  assert.equal(
    cue.update(state, recoveredAt + RECONNECT_STABLE, true, sounds),
    true,
  );
});

test("hidden, muted, disabled, stale and interrupted recoveries never replay", () => {
  for (const scenario of [
    "hidden",
    "muted",
    "volume",
    "disabled",
    "stale",
    "interrupted",
  ]) {
    const { cue, state, recoveredAt } = outage();
    cue.update(state, recoveredAt, true, sounds);
    if (scenario === "interrupted") state.connection = "reconnecting";
    assert.equal(
      cue.update(
        state,
        recoveredAt + (scenario === "stale" ? 9000 : 1000),
        scenario !== "hidden",
        {
          ...sounds,
          enabled: scenario !== "muted",
          volume: scenario === "volume" ? 0 : 35,
          reconnected: scenario !== "disabled",
        },
      ),
      false,
    );
    state.connection = "connected";
    assert.equal(
      cue.update(state, recoveredAt + 10001, true, sounds),
      false,
      scenario,
    );
  }
});

test("SoundCues routes recovery and consumes it once", () => {
  const policy = new SoundCues(0, () => 0),
    state = snapshot();
  policy.update(state, 0);
  state.connection = "reconnecting";
  policy.update(state, 1000);
  state.connection = "connected";
  policy.update(state, 11000);
  assert.deepEqual(policy.update(state, 14000), ["reconnected"]);
  assert.deepEqual(policy.update(state, 14001), []);
});

test("completion consumes a simultaneous recovery without queueing a later announcement", () => {
  const policy = new SoundCues(0, () => 0),
    state = snapshot();
  policy.update(state, 0);
  state.connection = "reconnecting";
  policy.update(state, 1000);
  state.connection = "connected";
  policy.update(state, 11000);
  state.sessions = [{ sessionId: "front", title: "Task", running: false }];
  state.completions = [{ id: "done", sessionId: "front", at: 14000 }];
  assert.deepEqual(policy.update(state, 14000), ["completion"]);
  assert.deepEqual(policy.update(state, 14001), []);
});
