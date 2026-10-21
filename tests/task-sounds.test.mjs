import test from "node:test";
import assert from "node:assert/strict";
import {
  SoundCues,
  SOUND_DEFAULTS,
  patchSoundSettings,
} from "../shared/sound.mjs";
import { recordTaskSound, TaskSoundRecorder } from "../shared/task-sounds.mjs";
import { reduceActivity } from "../shared/activity.mjs";

const hostError = (id, message = "failure") => ({
  type: "host/agent-error",
  id,
  message,
});
const terminalError = (seq, message = "failure") => ({
  type: "turn/end",
  seq,
  data: { reason: { kind: "error", error: { message } } },
});

test("distinct host errors notify without a new turn, while repeated RPCs stay consumed", () => {
  const recorder = new TaskSoundRecorder();
  let cues = recorder.record([], "front", hostError("first"), 1000, 1);
  const first = cues[0].id;
  cues = recorder.record(cues, "front", hostError("second"), 8000, 1, true);
  assert.equal(cues.length, 1);
  assert.notEqual(cues[0].id, first);
  for (const id of ["first", "second"])
    assert.equal(
      recorder.record(cues, "front", hostError(id), 15000, 1, true),
      cues,
    );
  // Expiring the sound cue does not forget the underlying host RPC identity.
  assert.deepEqual(
    recorder.record([], "front", hostError("first"), 20000, 1, true),
    [],
  );
});

test("host and terminal reports pair once in either order without swallowing later errors", () => {
  for (const events of [
    [hostError("first"), terminalError(2)],
    [terminalError(2), hostError("first")],
  ]) {
    const recorder = new TaskSoundRecorder();
    const first = recorder.record([], "front", events[0], 1000, 1);
    assert.equal(
      recorder.record(first, "front", events[1], 1100, 1, true),
      first,
    );
    const next = recorder.record(
      first,
      "front",
      hostError("second"),
      3000,
      1,
      true,
    );
    assert.notEqual(next[0].id, first[0].id);
    assert.equal(
      recorder.record(next, "front", hostError("first"), 3100, 1, true),
      next,
    );
  }
});

test("late mux output does not announce the same host failure again", () => {
  for (const [type, data] of [
    ["assistant/chunk", { chunk: { type: "text-delta", text: "Partial" } }],
    [
      "assistant/message",
      { message: { content: [{ type: "text", text: "Partial" }] } },
    ],
    ["step/start", {}],
    ["tool/call", { callId: "read", name: "read_file" }],
    ["tool/result", {}],
  ]) {
    const recorder = new TaskSoundRecorder();
    const state = snapshot(),
      policy = new SoundCues(1000);
    policy.update(state, 1000);
    const first = recorder.record([], "front", hostError("first"), 1500, 1);
    state.taskSounds = first;
    state.activity.front = { status: "error", seq: 1 };
    assert.deepEqual(policy.update(state, 1500), ["failure"]);
    const cue = policy.taskCues.failure;

    const output = { type, data, seq: 2 };
    state.activity.front = reduceActivity(state.activity.front, output, 3500);
    state.taskSounds = recorder.record(first, "front", output, 3500, 1, true);
    const continuingFailure = state.activity.front.status === "error";
    assert.equal(continuingFailure, false, type);
    assert.deepEqual(policy.update(state, 3500), [], type);
    assert.equal(policy.taskIsCurrent(state, 3500, cue), true, type);
    const end = terminalError(3);
    state.activity.front = reduceActivity(state.activity.front, end, 3600);
    state.taskSounds = recorder.record(
      first,
      "front",
      end,
      3600,
      1,
      continuingFailure,
    );
    assert.equal(state.taskSounds, first, type);
    assert.deepEqual(policy.update(state, 3600), [], type);

    // Pairing consumes only the matching report, not a later independent error.
    state.taskSounds = recorder.record(
      first,
      "front",
      hostError("second"),
      4000,
      1,
      true,
    );
    assert.deepEqual(policy.update(state, 4000), ["failure"], type);
  }
});

test("host-first pairing cannot cross a new turn, a non-error end or a different failure", () => {
  for (const scenario of [
    "turn",
    "completed",
    "cancelled",
    "message",
    "expired",
    "clock",
    "connection",
    "session",
  ]) {
    const recorder = new TaskSoundRecorder();
    let cues = recorder.record([], "front", hostError("first"), 1000, 1);
    const firstId = cues[0].id;
    if (scenario === "turn")
      cues = recorder.record(
        cues,
        "front",
        { type: "turn/start", seq: 2 },
        1100,
        1,
      );
    if (["completed", "cancelled"].includes(scenario))
      cues = recorder.record(
        cues,
        "front",
        { type: "turn/end", seq: 2, data: { reason: scenario } },
        1100,
        1,
      );
    const next = recorder.record(
      cues,
      scenario === "session" ? "other" : "front",
      terminalError(3, scenario === "message" ? "another failure" : "failure"),
      scenario === "expired" ? 7000 : scenario === "clock" ? 999 : 1200,
      scenario === "connection" ? 2 : 1,
      false,
    );
    assert.notEqual(next.at(-1).id, firstId, scenario);
    assert.equal(next.at(-1).kind, "failure", scenario);
  }
});

test("unrelated failures do not pair across recovery, new turns, messages, time or connections", () => {
  for (const scenario of [
    "recovered",
    "turn",
    "message",
    "expired",
    "clock",
    "connection",
    "session",
  ]) {
    const recorder = new TaskSoundRecorder();
    let cues = recorder.record([], "front", terminalError(2), 1000, 1);
    const firstId = cues[0].id;
    if (scenario === "turn")
      cues = recorder.record(
        cues,
        "front",
        { type: "turn/start", seq: 3 },
        1100,
        1,
      );
    const next = recorder.record(
      cues,
      scenario === "session" ? "other" : "front",
      hostError("new", scenario === "message" ? "another failure" : "failure"),
      scenario === "expired" ? 7000 : scenario === "clock" ? 999 : 1200,
      scenario === "connection" ? 2 : 1,
      scenario !== "recovered",
    );
    assert.notEqual(next.at(-1).id, firstId, scenario);
    assert.equal(next.at(-1).kind, "failure", scenario);
  }
  const recorder = new TaskSoundRecorder();
  const first = recorder.record([], "front", hostError("same"), 1000, 1);
  assert.notEqual(
    recorder.record(first, "front", hostError("same"), 1100, 2)[0].id,
    first[0].id,
  );
});

test("a failure still notifies when its first snapshot already includes late output", () => {
  const state = snapshot(),
    policy = new SoundCues(1000),
    recorder = new TaskSoundRecorder();
  policy.update(state, 1000);
  state.taskSounds = recorder.record([], "front", hostError("first"), 1500, 1);
  state.activity.front = { status: "replying" };
  assert.deepEqual(policy.update(state, 1600), ["failure"]);
  const cue = policy.taskCues.failure;
  state.taskSounds = recorder.record(
    state.taskSounds,
    "front",
    { type: "turn/start", seq: 2 },
    1700,
    1,
  );
  assert.equal(policy.taskIsCurrent(state, 1700, cue), false);
});

function snapshot() {
  return {
    connection: "connected",
    connectionEpoch: 1,
    sessions: [{ sessionId: "front", running: false }],
    activity: {},
    pending: [],
    completions: [],
    taskSounds: [],
    surface: { section: null },
    config: { endpoint: "http://localhost:3080", sounds: SOUND_DEFAULTS },
    lastInteractionAt: 1000,
  };
}

function task(state, kind, sessionId = "front", at = 2000) {
  state.taskSounds.push({ id: `${sessionId}:${at}`, kind, sessionId, at });
  state.activity[sessionId] = {
    status: kind === "failure" ? "error" : "thinking",
  };
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (session) session.running = kind === "started";
}

function attention(state, sessionId = "front", rpcId = "ask") {
  state.pending.push({ sessionId, rpcId, type: "question/requested" });
}

test("only accepted live start/failure transitions create task cues; terminal events clear obsolete starts", () => {
  const start = { seq: 1, type: "turn/start" };
  let events = recordTaskSound([], "front", start, 1000, 1);
  assert.equal(events[0].kind, "started");
  assert.equal(recordTaskSound(events, "front", start, 1100, 1), events);
  for (const reason of [
    "completed",
    "cancelled",
    "interrupted",
    "max-tokens",
  ]) {
    assert.deepEqual(
      recordTaskSound(
        events,
        "front",
        {
          seq: 2,
          type: "turn/end",
          data: { reason },
        },
        1200,
        1,
      ),
      [],
    );
  }
  for (const reason of ["error", { kind: "failed" }, { type: "error" }]) {
    const result = recordTaskSound(
      events,
      "front",
      {
        seq: 2,
        type: "turn/end",
        data: { reason },
      },
      1200,
      1,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "failure");
  }
  for (const event of [
    { seq: 2, type: "tool/result", data: { error: true } },
    { type: "turn/end", data: { reason: "error" } },
    { type: "host/session-status", running: true },
    { type: "host/agent-error" },
  ])
    assert.equal(recordTaskSound(events, "front", event, 1200), events);
  events = recordTaskSound(
    events,
    "front",
    { type: "host/agent-error", id: "rpc" },
    1300,
    1,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "failure");
  assert.notEqual(
    recordTaskSound([], "front", start, 1000, 2)[0].id,
    recordTaskSound([], "front", start, 1000, 1)[0].id,
  );
  let bounded = [];
  for (let n = 0; n < 120; n++)
    bounded = recordTaskSound(bounded, String(n), start, 1000, 1);
  assert.equal(bounded.length, 100);
  assert.equal(recordTaskSound(bounded, "new", start, 7000, 1).length, 1);
});

test("new switches migrate and persist independently; task starts are opt-in", () => {
  assert.equal(SOUND_DEFAULTS.started, false);
  for (const kind of ["started", "attention", "failure"]) {
    assert.equal(patchSoundSettings({}, { [kind]: false })[kind], false);
    assert.equal(patchSoundSettings({}, { [kind]: true })[kind], true);
    assert.throws(() => patchSoundSettings({}, { [kind]: 1 }), /无效声音设置/);
  }
  const state = snapshot(),
    cues = new SoundCues(1000);
  cues.update(state, 1000);
  task(state, "started");
  assert.deepEqual(cues.update(state, 2000), []);
  state.config.sounds = { ...SOUND_DEFAULTS, started: true };
  assert.deepEqual(cues.update(state, 2100), [], "enabling does not replay");
  task(state, "started", "front", 2200);
  assert.deepEqual(cues.update(state, 2200, false), ["started"]);
  assert.deepEqual(cues.update(state, 2300), []);
});

test("initial events stay quiet; live errors and requests notify hidden ordinary sessions once", () => {
  for (const kind of ["failure", "attention"]) {
    const state = snapshot(),
      cues = new SoundCues(1000);
    if (kind === "failure") task(state, kind, "front", 1000);
    else attention(state);
    assert.deepEqual(cues.update(state, 1000), []);
    state.sessions.push({ sessionId: "back", running: false });
    if (kind === "failure") task(state, kind, "back");
    else attention(state, "back", "new");
    assert.deepEqual(cues.update(state, 2000, false), [kind]);
    assert.deepEqual(cues.update(state, 2100, false), []);
  }
});

test("late session lists allow fresh cues but never revive muted, expired or subagent events", () => {
  for (const kind of ["started", "attention", "failure"]) {
    for (const reason of [
      "live",
      "muted",
      "disabled",
      "expired",
      "child",
      "disconnected",
    ]) {
      const state = snapshot(),
        cues = new SoundCues(1000);
      state.config.sounds = { ...SOUND_DEFAULTS, started: true };
      cues.update(state, 1000);
      if (kind === "attention") attention(state, "new");
      else task(state, kind, "new");
      assert.deepEqual(cues.update(state, 2000), []);
      if (reason === "muted") state.config.sounds.volume = 0;
      if (reason === "disabled") state.config.sounds[kind] = false;
      if (reason === "disconnected") state.connection = "reconnecting";
      const now = reason === "expired" ? 8000 : 2100;
      assert.deepEqual(cues.update(state, now), []);
      state.config.sounds = { ...SOUND_DEFAULTS, started: true };
      state.connection = "connected";
      state.sessions.push({
        sessionId: "new",
        running: kind === "started",
        ...(reason === "child" ? { origin: "subagent" } : {}),
      });
      assert.deepEqual(
        cues.update(state, now + 1),
        reason === "live" ? [kind] : [],
        `${kind}: ${reason}`,
      );
      assert.deepEqual(cues.update(state, now + 2), []);
    }
  }
});

test("resolved, replaced and reconnected cues cannot play late", () => {
  for (const kind of ["started", "attention", "failure"]) {
    for (const change of [
      (state) => (state.connection = "reconnecting"),
      (state) => state.connectionEpoch++,
      (state) => (state.config.endpoint = "http://localhost:4000"),
      (state) => (state.sessions = []),
      (state) => {
        state.pending = [];
        state.taskSounds = [];
      },
      (state) => {
        state.sessions[0].running = false;
        state.activity.front = { status: "done" };
        state.pending = [];
        state.taskSounds = recordTaskSound(
          state.taskSounds,
          "front",
          {
            type: "turn/end",
            seq: 2,
            data: { reason: "completed" },
          },
          2100,
          state.connectionEpoch,
        );
      },
    ]) {
      const state = snapshot(),
        cues = new SoundCues(1000);
      state.config.sounds = { ...SOUND_DEFAULTS, started: true };
      cues.update(state, 1000);
      if (kind === "attention") attention(state);
      else task(state, kind);
      assert.deepEqual(cues.update(state, 2000), [kind]);
      const cue = cues.taskCues[kind];
      assert.equal(cues.taskIsCurrent(state, 2001, cue), true);
      assert.equal(cues.taskIsCurrent(state, 8000, cue), false);
      change(state);
      assert.equal(cues.taskIsCurrent(state, 2100, cue), false);
    }
  }
});

test("pending requests survive same-endpoint reconnects without repeating; a new request still sounds", () => {
  const state = snapshot(),
    cues = new SoundCues(1000);
  cues.update(state, 1000);
  attention(state);
  assert.deepEqual(cues.update(state, 2000), ["attention"]);
  state.connection = "reconnecting";
  state.connectionEpoch++;
  state.pending = [];
  cues.update(state, 2100);
  state.connection = "connected";
  attention(state);
  assert.deepEqual(cues.update(state, 2200), []);
  attention(state, "front", "new");
  assert.deepEqual(cues.update(state, 2300), ["attention"]);
  state.config.endpoint = "http://localhost:4000";
  assert.deepEqual(
    cues.update(state, 2400),
    ["attention"],
    "RPC IDs are scoped to a server",
  );
});

test("simultaneous important cues coalesce, with no later backlog of start or completion sounds", () => {
  const state = snapshot(),
    cues = new SoundCues(1000);
  state.config.sounds = { ...SOUND_DEFAULTS, started: true };
  state.sessions.push({ sessionId: "other", running: true });
  cues.update(state, 1000);
  task(state, "started", "other");
  task(state, "failure");
  state.completions = [{ id: "completed", sessionId: "front", at: 2000 }];
  attention(state);
  assert.deepEqual(cues.update(state, 2000), ["attention"]);
  assert.deepEqual(cues.update(state, 2100), []);
});

test("a disabled completion does not consume a simultaneous enabled start", () => {
  const state = snapshot(),
    cues = new SoundCues(1000);
  state.config.sounds = { ...SOUND_DEFAULTS, started: true, completion: false };
  state.sessions.push({ sessionId: "other", running: false });
  cues.update(state, 1000);
  task(state, "started");
  state.completions = [{ id: "completed", sessionId: "other", at: 2000 }];
  assert.deepEqual(cues.update(state, 2000), ["started"]);
  assert.deepEqual(cues.update(state, 2100), []);
});
