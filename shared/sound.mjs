import { overallMood } from "./activity.mjs";
import { activeCompletion, COMPLETION_DURATION } from "./completion.mjs";
import { DEFAULT_SOUND_VOICE, isSoundVoice } from "./voices.mjs";
import { TASK_SOUND_DURATION } from "./task-sounds.mjs";
import { ReconnectionCues } from "./companion-sounds.mjs";

export const SOUND_DEFAULTS = Object.freeze({
  enabled: true,
  volume: 35,
  voice: DEFAULT_SOUND_VOICE,
  pet: true,
  angry: true,
  completion: true,
  idle: true,
  started: false,
  attention: true,
  failure: true,
  shy: true,
  wake: true,
  sleep: false,
  welcome: true,
  moved: false,
  reconnected: false,
});

export function normalizeSoundSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const touch = typeof source.pet === "boolean" ? source.pet : true;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    volume:
      typeof source.volume === "number" && Number.isFinite(source.volume)
        ? Math.round(Math.min(100, Math.max(0, source.volume)))
        : SOUND_DEFAULTS.volume,
    voice: isSoundVoice(source.voice) ? source.voice : DEFAULT_SOUND_VOICE,
    pet: typeof source.pet === "boolean" ? source.pet : true,
    // Existing users who muted touch responses should keep that preference.
    angry:
      typeof source.angry === "boolean"
        ? source.angry
        : typeof source.pet === "boolean"
          ? source.pet
          : true,
    completion:
      typeof source.completion === "boolean" ? source.completion : true,
    idle: typeof source.idle === "boolean" ? source.idle : true,
    started: typeof source.started === "boolean" ? source.started : false,
    attention: typeof source.attention === "boolean" ? source.attention : true,
    failure: typeof source.failure === "boolean" ? source.failure : true,
    shy: typeof source.shy === "boolean" ? source.shy : touch,
    wake: typeof source.wake === "boolean" ? source.wake : touch,
    sleep: typeof source.sleep === "boolean" ? source.sleep : false,
    welcome: typeof source.welcome === "boolean" ? source.welcome : touch,
    moved: typeof source.moved === "boolean" ? source.moved : false,
    reconnected:
      typeof source.reconnected === "boolean" ? source.reconnected : false,
  };
}

export function patchSoundSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("无效声音设置");
  const entries = Object.entries(patch);
  if (
    !entries.length ||
    entries.some(([key, value]) =>
      key === "voice"
        ? !isSoundVoice(value)
        : key === "volume"
          ? typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 100
          : ![
              "enabled",
              "pet",
              "angry",
              "completion",
              "idle",
              "started",
              "attention",
              "failure",
              "shy",
              "wake",
              "sleep",
              "welcome",
              "moved",
              "reconnected",
            ].includes(key) || typeof value !== "boolean",
    )
  )
    throw new Error("无效声音设置");
  return normalizeSoundSettings({
    ...normalizeSoundSettings(current),
    ...patch,
  });
}

function idleAvailable(state, now, visible) {
  return (
    visible &&
    overallMood(state, now) === "idle" &&
    !state.sessions.some((session) => session.running) &&
    !state.pending.length &&
    !state.surface.section &&
    !["sleepy", "sleeping"].includes(state.config.expression)
  );
}

export class SoundCues {
  constructor(now = Date.now(), random = Math.random) {
    this.random = random;
    this.initialized = false;
    this.seen = new Set();
    this.completionCue = null;
    /** @type {Record<string, any>} */
    this.taskCues = {};
    this.seenTasks = new Set();
    this.seenPending = new Set();
    this.pendingArrivals = new Map();
    this.endpoint = null;
    this.reconnection = new ReconnectionCues();
    this.idleRevision = 0;
    this.lastActive = now;
    this.nextIdle = now + this.idleDelay();
  }

  idleDelay() {
    return 75000 + this.random() * 30000;
  }

  engage(now = Date.now()) {
    this.idleRevision++;
    this.lastActive = now;
    this.nextIdle = now + this.idleDelay();
  }

  idleIsCurrent(state, now, visible, revision) {
    return (
      revision === this.idleRevision &&
      idleAvailable(state, now, visible) &&
      !(state.lastInteractionAt > this.lastActive) &&
      now >= this.lastActive &&
      now - this.lastActive < 240000
    );
  }

  completionIsCurrent(state, now, cue) {
    return (
      !!cue &&
      state.connection === "connected" &&
      state.connectionEpoch === cue.connectionEpoch &&
      state.config.endpoint === cue.endpoint &&
      now >= cue.at &&
      now - cue.at < COMPLETION_DURATION &&
      state.sessions.some(
        (session) =>
          session.sessionId === cue.sessionId && session.origin !== "subagent",
      ) &&
      (state.completions || []).some(
        (item) => item.id === cue.id && item.at === cue.at,
      )
    );
  }

  taskIsCurrent(state, now, cue) {
    if (
      !cue ||
      state.connection !== "connected" ||
      state.connectionEpoch !== cue.connectionEpoch ||
      state.config.endpoint !== cue.endpoint ||
      now < cue.at ||
      now - cue.at >= TASK_SOUND_DURATION ||
      !state.sessions.some(
        (session) =>
          session.sessionId === cue.sessionId && session.origin !== "subagent",
      )
    )
      return false;
    if (cue.kind === "attention")
      return state.pending.some((item) => item.rpcId === cue.rpcId);
    if (!(state.taskSounds || []).some((item) => item.id === cue.id))
      return false;
    if (cue.kind === "started")
      return (
        state.sessions.some(
          (session) => session.sessionId === cue.sessionId && session.running,
        ) && !state.pending.some((item) => item.sessionId === cue.sessionId)
      );
    // The recorder removes failures at real task boundaries. Late output may
    // change the displayed activity without resolving the recorded failure.
    return cue.kind === "failure";
  }

  taskUpdates(state, now, sounds) {
    const enabled = (kind) =>
      this.initialized &&
      state.connection === "connected" &&
      sounds.enabled &&
      sounds.volume > 0 &&
      sounds[kind];
    const bind = (item) => ({
      ...item,
      endpoint: state.config.endpoint,
      connectionEpoch: state.connectionEpoch,
    });
    this.taskCues = {};
    const tasks = state.taskSounds || [];
    const known = new Set(state.sessions.map((item) => item.sessionId));
    const consumed = new Set();
    for (const item of tasks) {
      if (this.seenTasks.has(item.id)) {
        consumed.add(item.id);
        continue;
      }
      // As with completion reminders, a live event may precede session.list.
      if (
        enabled(item.kind) &&
        !known.has(item.sessionId) &&
        now >= item.at &&
        now - item.at < TASK_SOUND_DURATION
      )
        continue;
      consumed.add(item.id);
      const cue = bind(item);
      if (enabled(item.kind) && this.taskIsCurrent(state, now, cue))
        this.taskCues[item.kind] = cue;
    }
    this.seenTasks = consumed;

    if (this.endpoint !== state.config.endpoint) {
      this.seenPending.clear();
      this.pendingArrivals.clear();
      this.endpoint = state.config.endpoint;
    }
    const pendingIds = new Set(state.pending.map((item) => item.rpcId));
    for (const [id] of this.pendingArrivals)
      if (!pendingIds.has(id)) this.pendingArrivals.delete(id);
    for (const item of state.pending) {
      if (!item.rpcId || this.seenPending.has(item.rpcId)) continue;
      this.seenPending.add(item.rpcId);
      if (enabled("attention"))
        this.pendingArrivals.set(
          item.rpcId,
          bind({ ...item, kind: "attention", at: now }),
        );
    }
    for (const [id, cue] of this.pendingArrivals) {
      if (
        enabled("attention") &&
        cue.connectionEpoch === state.connectionEpoch &&
        !known.has(cue.sessionId) &&
        now >= cue.at &&
        now - cue.at < TASK_SOUND_DURATION
      )
        continue;
      this.pendingArrivals.delete(id);
      if (enabled("attention") && this.taskIsCurrent(state, now, cue))
        this.taskCues.attention = cue;
    }
    // Remember pending RPCs across reconnections, but bound completed history.
    if (this.seenPending.size > 512)
      for (const id of this.seenPending) {
        if (!pendingIds.has(id)) this.seenPending.delete(id);
        if (this.seenPending.size <= 512) break;
      }
    return ["attention", "failure", "started"].filter(
      (kind) => this.taskCues[kind],
    );
  }

  update(state, now = Date.now(), visible = true, awake = true) {
    const completions = state.completions || [];
    const fresh = completions.filter((item) => !this.seen.has(item.id));
    const completion =
      this.initialized &&
      activeCompletion({ ...state, completions: fresh }, now);
    const event = completion && fresh.find((item) => item.id === completion.id);
    this.completionCue = event
      ? {
          ...event,
          endpoint: state.config.endpoint,
          connectionEpoch: state.connectionEpoch,
        }
      : null;
    const sounds = normalizeSoundSettings(state.config.sounds);
    const reconnected = this.reconnection.update(state, now, visible, sounds);
    const canWait =
      this.initialized &&
      state.connection === "connected" &&
      sounds.enabled &&
      sounds.volume > 0 &&
      sounds.completion;
    const knownSessions = new Set(state.sessions.map((item) => item.sessionId));
    // A live completion can beat session.list. Keep it fresh until the list
    // identifies the session, but consume suppressed or expired cues normally.
    this.seen = new Set(
      completions
        .filter(
          (item) =>
            this.seen.has(item.id) ||
            !canWait ||
            knownSessions.has(item.sessionId) ||
            now < item.at ||
            now - item.at >= COMPLETION_DURATION,
        )
        .map((item) => item.id),
    );
    const tasks = this.taskUpdates(state, now, sounds);
    this.initialized = true;
    // Coalesce simultaneous events; action-needed cues take precedence over
    // celebrations, and both take precedence over optional start responses.
    const kind =
      tasks.find((kind) => kind !== "started") ||
      (completion && canWait ? "completion" : tasks[0]) ||
      (reconnected ? "reconnected" : null);
    const cues = kind ? [kind] : [];
    if (!idleAvailable(state, now, visible && awake)) {
      this.engage(now);
      return cues;
    }
    if (state.lastInteractionAt > this.lastActive)
      this.engage(Math.min(now, state.lastInteractionAt));
    if (now < this.lastActive) {
      this.engage(now);
      return cues;
    }
    if (now - this.lastActive >= 240000) {
      this.nextIdle = now + this.idleDelay();
      return cues;
    }
    if (now >= this.nextIdle) {
      cues.push("idle");
      this.nextIdle = now + 120000 + this.random() * 60000;
    }
    return cues;
  }
}
