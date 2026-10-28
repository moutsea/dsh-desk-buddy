import { normalizeSoundSettings } from "../shared/sound.mjs";
import { isSoundVoice, SOUND_VARIANTS } from "../shared/voices.mjs";

export type SoundKind =
  | "pet"
  | "angry"
  | "completion"
  | "idle"
  | "started"
  | "attention"
  | "failure"
  | "shy"
  | "wake"
  | "sleep"
  | "welcome"
  | "moved"
  | "reconnected";
type ClipKind = SoundKind | "preview";
export type SoundSettings = {
  enabled: boolean;
  volume: number;
  voice: string;
  pet: boolean;
  angry: boolean;
  completion: boolean;
  idle: boolean;
  started: boolean;
  attention: boolean;
  failure: boolean;
  shy: boolean;
  wake: boolean;
  sleep: boolean;
  welcome: boolean;
  moved: boolean;
  reconnected: boolean;
};
type Playback = {
  kind: ClipKind;
  audition: boolean;
  requestedAt: number;
  isCurrent?: () => boolean;
};
type PendingPlayback = Playback & {
  cancelled: boolean;
  cancel: () => void;
};
type Voice = Playback & {
  gain: GainNode;
  source: AudioBufferSourceNode;
};
type BufferLoad = {
  promise: Promise<AudioBuffer>;
  cancel: () => void;
};
const cooldowns: Record<SoundKind, number> = {
  pet: 350,
  angry: 6000,
  completion: 1200,
  idle: 30000,
  started: 5000,
  attention: 1500,
  failure: 1500,
  shy: 60000,
  wake: 60000,
  sleep: 300000,
  welcome: 600000,
  moved: 30000,
  reconnected: 60000,
};
const loadDeadline = 1000;
// Decoded PCM is several times larger than the compressed clip. Keep the
// current voice plus a little headroom instead of retaining every auditioned
// voice for the life of the window.
const maxCachedClips = 48;

function priority(playback: Playback) {
  if (playback.audition) return 1;
  if (["attention", "failure"].includes(playback.kind)) return 3;
  if (playback.kind === "completion") return 2;
  if (["started", "angry", "wake", "welcome"].includes(playback.kind)) return 1;
  return 0;
}

function canInterrupt(next: Playback, current: Playback) {
  return (
    priority(next) > priority(current) ||
    (next.audition && priority(current) <= 1)
  );
}

export class PetAudio {
  private context?: AudioContext;
  private output?: GainNode;
  private buffers = new Map<string, BufferLoad>();
  private settings: SoundSettings = normalizeSoundSettings(null);
  private voices = new Set<Voice>();
  private lastPlayed: Partial<Record<SoundKind, number>> = {};
  private pending?: PendingPlayback;
  private disposed = false;
  private lastClips = new Map<string, string>();

  configure(value: unknown) {
    const settings = normalizeSoundSettings(value);
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) return;
    const voiceChanged = settings.voice !== this.settings.voice;
    this.settings = settings;
    if (this.pending && (voiceChanged || !this.isCurrent(this.pending)))
      this.cancelPending();
    if (voiceChanged) this.lastPlayed = {};
    if (this.context && this.output) {
      this.output.gain.cancelAndHoldAtTime(this.context.currentTime);
      this.output.gain.linearRampToValueAtTime(
        settings.enabled ? settings.volume / 100 : 0,
        this.context.currentTime + 0.02,
      );
      for (const voice of this.voices)
        if (voiceChanged || !this.allowed(voice.kind)) this.stopVoice(voice);
    }
  }

  private allowed(kind: ClipKind) {
    return (
      !this.disposed &&
      this.settings.enabled &&
      this.settings.volume > 0 &&
      (kind === "preview" || this.settings[kind])
    );
  }

  private isCurrent(playback: Playback) {
    return this.allowed(playback.kind) && (playback.isCurrent?.() ?? true);
  }

  refresh() {
    if (this.pending && !this.isCurrent(this.pending)) this.cancelPending();
    else if (
      this.pending &&
      performance.now() - this.pending.requestedAt > loadDeadline
    )
      // Expiry releases priority, but remains a genuine playback failure.
      this.pending = undefined;
    for (const voice of this.voices)
      if (!this.isCurrent(voice)) this.stopVoice(voice);
  }

  private cancelPending() {
    this.pending?.cancel();
    this.pending = undefined;
  }

  private stopVoice(voice: Voice) {
    const now = this.context!.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, 0.005);
    voice.source.stop(now + 0.03);
    this.voices.delete(voice);
  }

  private buffer(context: AudioContext, voice: string, kind: string) {
    const key = `${voice}/${kind}`;
    let load = this.buffers.get(key);
    if (load) {
      // Refresh insertion order so the active voice stays cached.
      this.buffers.delete(key);
      this.buffers.set(key, load);
    } else {
      const controller = new AbortController();
      let settled = false;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.buffers.get(key) === pending) this.buffers.delete(key);
          reject(new Error("Voice clip loading cancelled"));
          controller.abort();
        };
      });
      const timer = setTimeout(cancel, loadDeadline);
      const pending: BufferLoad = {
        cancel,
        promise: Promise.race([
          (async () => {
            const response = await fetch(
              `${import.meta.env?.BASE_URL ?? "./"}voices/${key}.wav`,
              { signal: controller.signal },
            );
            if (!response.ok) throw new Error("Voice clip unavailable");
            const data = await response.arrayBuffer();
            // decodeAudioData cannot be aborted; the race also bounds decoding.
            controller.signal.throwIfAborted();
            return context.decodeAudioData(data);
          })(),
          cancelled,
        ])
          .catch((error) => {
            if (this.buffers.get(key) === pending) this.buffers.delete(key);
            controller.abort();
            throw error;
          })
          .finally(() => {
            settled = true;
            clearTimeout(timer);
          }),
      };
      load = pending;
      this.buffers.set(key, load);
      for (const cached of this.buffers.keys())
        if (this.buffers.size > maxCachedClips) this.buffers.delete(cached);
    }
    return load;
  }

  play(kind: SoundKind, isCurrent?: () => boolean) {
    return this.playClip(kind, this.settings.voice, { isCurrent });
  }

  preview(voice: string, kind: ClipKind = "preview", onAccepted?: () => void) {
    if (!isSoundVoice(voice)) {
      onAccepted?.();
      return Promise.resolve("unavailable");
    }
    return this.playClip(kind, voice, { audition: true, onAccepted });
  }

  private async playClip(
    kind: ClipKind,
    voiceId: string,
    {
      audition = false,
      isCurrent,
      onAccepted,
    }: {
      audition?: boolean;
      isCurrent?: () => boolean;
      onAccepted?: () => void;
    } = {},
  ) {
    this.refresh();
    const requestedAt = performance.now();
    const playback: PendingPlayback = {
      kind,
      audition,
      requestedAt,
      isCurrent,
      cancelled: false,
      cancel: () => {},
    };
    if (!this.isCurrent(playback)) return "muted";
    if (
      (!audition &&
        kind !== "preview" &&
        requestedAt - (this.lastPlayed[kind] ?? -Infinity) < cooldowns[kind]) ||
      (this.pending && !canInterrupt(playback, this.pending)) ||
      [...this.voices].some((voice) => !canInterrupt(playback, voice))
    )
      return "busy";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<null>((resolve) => {
      playback.cancel = () => {
        playback.cancelled = true;
        clearTimeout(timer);
        resolve(null);
      };
    });
    // Reserve priority while loading, before an AudioBufferSourceNode exists.
    this.cancelPending();
    this.pending = playback;
    try {
      onAccepted?.();
      if (playback.cancelled) return "muted";
      if (!this.context) {
        this.context = new AudioContext();
        this.output = this.context.createGain();
        this.output.gain.value = this.settings.volume / 100;
        this.output.connect(this.context.destination);
      }
      const context = this.context;
      const variantKey = `${audition ? "preview" : "auto"}/${voiceId}/${kind}`;
      const lastClip = this.lastClips.get(variantKey);
      const variants = SOUND_VARIANTS[kind as keyof typeof SOUND_VARIANTS];
      // Preserve the original first response, then vary successful playbacks.
      // Auditions have their own rotation and do not consume automatic choices.
      const choices = variants?.filter((clip) => clip !== lastClip);
      const clip =
        lastClip && choices?.length
          ? choices[Math.floor(Math.random() * choices.length)]
          : kind;
      const load = this.buffer(context, voiceId, clip);
      const result = await Promise.race([
        Promise.all([
          load.promise,
          context.state !== "running" ? context.resume() : Promise.resolve(),
        ]),
        new Promise<never>((_, reject) => {
          // Bound resume() too: it may never settle if the output is unavailable.
          timer = setTimeout(
            () => {
              load.cancel();
              reject(new Error("Voice playback timed out"));
            },
            Math.max(0, loadDeadline - (performance.now() - requestedAt)),
          );
        }),
        cancelled,
      ]);
      if (!result || playback.cancelled || !this.isCurrent(playback))
        return "muted";
      const [buffer] = result;
      if (
        context.state !== "running" ||
        performance.now() - requestedAt > loadDeadline
      )
        return "unavailable";
      if (this.pending !== playback) return "muted";
      for (const voice of this.voices) this.stopVoice(voice);
      if (!audition && kind !== "preview")
        this.lastPlayed[kind] = performance.now();
      const gain = context.createGain();
      gain.connect(this.output!);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const voice: Voice = { ...playback, gain, source };
      this.voices.add(voice);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        this.voices.delete(voice);
      };
      source.start(context.currentTime + 0.01);
      if (variants) this.lastClips.set(variantKey, clip);
      return "played";
    } catch {
      return playback.cancelled || !this.isCurrent(playback)
        ? "muted"
        : "unavailable";
    } finally {
      clearTimeout(timer);
      if (this.pending === playback) this.pending = undefined;
    }
  }

  dispose() {
    this.disposed = true;
    this.cancelPending();
    for (const voice of this.voices) this.stopVoice(voice);
    for (const load of this.buffers.values()) load.cancel();
    this.buffers.clear();
    void this.context?.close().catch(() => {});
  }
}
