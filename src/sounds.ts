import { normalizeSoundSettings } from "../shared/sound.mjs";

export type SoundKind = "pet" | "completion" | "idle";
export type SoundSettings = {
  enabled: boolean;
  volume: number;
  pet: boolean;
  completion: boolean;
  idle: boolean;
};
type Voice = {
  kind: SoundKind;
  gain: GainNode;
  tones: OscillatorNode[];
};
type Tone = {
  frequency: number;
  end?: number;
  at: number;
  duration: number;
  level: number;
  wave?: OscillatorType;
};
const melodies: Record<SoundKind, Tone[]> = {
  pet: [
    { frequency: 660, end: 880, at: 0, duration: 0.13, level: 0.2 },
    { frequency: 990, end: 880, at: 0.09, duration: 0.17, level: 0.13 },
  ],
  completion: [
    { frequency: 523.25, at: 0, duration: 0.22, level: 0.19 },
    { frequency: 659.25, at: 0.13, duration: 0.22, level: 0.18 },
    { frequency: 783.99, at: 0.26, duration: 0.24, level: 0.17 },
    { frequency: 1046.5, at: 0.4, duration: 0.38, level: 0.14 },
  ],
  idle: [
    { frequency: 440, end: 523.25, at: 0, duration: 0.28, level: 0.12 },
    { frequency: 392, end: 440, at: 0.22, duration: 0.3, level: 0.1 },
  ],
};
const cooldowns: Record<SoundKind, number> = {
  pet: 350,
  completion: 1200,
  idle: 30000,
};

export class PetAudio {
  private context?: AudioContext;
  private output?: GainNode;
  private settings: SoundSettings = normalizeSoundSettings(null);
  private voices = new Set<Voice>();
  private lastPlayed: Partial<Record<SoundKind, number>> = {};
  private revision = 0;
  private request = 0;
  private disposed = false;

  configure(value: unknown) {
    const settings = normalizeSoundSettings(value);
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) return;
    this.settings = settings;
    this.revision++;
    if (this.context && this.output) {
      this.output.gain.cancelAndHoldAtTime(this.context.currentTime);
      this.output.gain.linearRampToValueAtTime(
        settings.enabled ? settings.volume / 100 : 0,
        this.context.currentTime + 0.02,
      );
      for (const voice of this.voices)
        if (!this.allowed(voice.kind)) this.stopVoice(voice);
    }
  }

  private allowed(kind: SoundKind) {
    return (
      !this.disposed &&
      this.settings.enabled &&
      this.settings.volume > 0 &&
      this.settings[kind]
    );
  }

  private stopVoice(voice: Voice) {
    const now = this.context!.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, 0.005);
    for (const tone of voice.tones) tone.stop(now + 0.03);
    this.voices.delete(voice);
  }

  async play(kind: SoundKind) {
    if (!this.allowed(kind)) return "muted";
    const requestedAt = performance.now();
    if (
      requestedAt - (this.lastPlayed[kind] ?? -Infinity) < cooldowns[kind] ||
      (kind !== "completion" && this.voices.size > 0)
    )
      return "busy";
    const revision = this.revision;
    const request = ++this.request;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.output = this.context.createGain();
        this.output.gain.value = this.settings.volume / 100;
        this.output.connect(this.context.destination);
      }
      const context = this.context;
      if (context.state !== "running") await context.resume();
      if (context.state !== "running" || performance.now() - requestedAt > 1000)
        return "unavailable";
      if (
        revision !== this.revision ||
        request !== this.request ||
        !this.allowed(kind)
      )
        return "muted";
      if (kind === "completion")
        for (const voice of this.voices) this.stopVoice(voice);
      this.lastPlayed[kind] = performance.now();
      const gain = context.createGain();
      gain.connect(this.output!);
      const voice: Voice = { kind, gain, tones: [] };
      this.voices.add(voice);
      const now = context.currentTime + 0.01;
      for (const note of melodies[kind]) {
        const tone = context.createOscillator();
        const envelope = context.createGain();
        const start = now + note.at;
        tone.type = note.wave || "sine";
        tone.frequency.setValueAtTime(note.frequency, start);
        tone.frequency.exponentialRampToValueAtTime(
          note.end || note.frequency,
          start + note.duration,
        );
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(note.level, start + 0.018);
        envelope.gain.exponentialRampToValueAtTime(
          0.0001,
          start + note.duration,
        );
        tone.connect(envelope);
        envelope.connect(gain);
        voice.tones.push(tone);
        tone.onended = () => {
          tone.disconnect();
          envelope.disconnect();
          voice.tones = voice.tones.filter((item) => item !== tone);
          if (!voice.tones.length) {
            gain.disconnect();
            this.voices.delete(voice);
          }
        };
        tone.start(start);
        tone.stop(start + note.duration + 0.02);
      }
      return "played";
    } catch {
      return "unavailable";
    }
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    for (const voice of this.voices) this.stopVoice(voice);
    void this.context?.close().catch(() => {});
  }
}
