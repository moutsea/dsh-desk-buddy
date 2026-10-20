import { overallMood } from "./activity.mjs";
import { activeCompletion, COMPLETION_DURATION } from "./completion.mjs";
import { DEFAULT_SOUND_VOICE, isSoundVoice } from "./voices.mjs";

export const SOUND_DEFAULTS = Object.freeze({
  enabled: true,
  volume: 35,
  voice: DEFAULT_SOUND_VOICE,
  pet: true,
  completion: true,
  idle: true,
});

export function normalizeSoundSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    volume:
      typeof source.volume === "number" && Number.isFinite(source.volume)
        ? Math.round(Math.min(100, Math.max(0, source.volume)))
        : SOUND_DEFAULTS.volume,
    voice: isSoundVoice(source.voice) ? source.voice : DEFAULT_SOUND_VOICE,
    pet: typeof source.pet === "boolean" ? source.pet : true,
    completion:
      typeof source.completion === "boolean" ? source.completion : true,
    idle: typeof source.idle === "boolean" ? source.idle : true,
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
          : !["enabled", "pet", "completion", "idle"].includes(key) ||
            typeof value !== "boolean",
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

  update(state, now = Date.now(), visible = true) {
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
    this.initialized = true;
    const cues = completion ? ["completion"] : [];
    if (!idleAvailable(state, now, visible)) {
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
