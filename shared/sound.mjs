import { overallMood } from "./activity.mjs";
import { activeCompletion } from "./completion.mjs";

export const SOUND_DEFAULTS = Object.freeze({
  enabled: true,
  volume: 35,
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
      key === "volume"
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

export class SoundCues {
  constructor(now = Date.now(), random = Math.random) {
    this.random = random;
    this.initialized = false;
    this.seen = new Set();
    this.lastActive = now;
    this.nextIdle = now + this.idleDelay();
  }

  idleDelay() {
    return 75000 + this.random() * 30000;
  }

  engage(now = Date.now()) {
    this.lastActive = now;
    this.nextIdle = now + this.idleDelay();
  }

  update(state, now = Date.now(), visible = true) {
    const completions = state.completions || [];
    const fresh = completions.filter((item) => !this.seen.has(item.id));
    const completion =
      this.initialized &&
      activeCompletion({ ...state, completions: fresh }, now);
    this.seen = new Set(completions.map((item) => item.id));
    this.initialized = true;
    const cues = completion ? ["completion"] : [];
    if (
      overallMood(state, now) !== "idle" ||
      state.sessions.some((session) => session.running) ||
      state.pending.length ||
      state.surface.section ||
      !visible ||
      ["sleepy", "sleeping"].includes(state.config.expression)
    ) {
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
