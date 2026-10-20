import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { normalizeSoundSettings } from "../shared/sound.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";
import { useSounds } from "./SoundProvider";
import type { SoundSettings as Settings, SoundKind } from "./sounds";

const events: { kind: SoundKind; label: string; description: string }[] = [
  {
    kind: "pet",
    label: "摸摸桌宠",
    description: "轻点角色时，轻声回应「嗯？嘿嘿」。",
  },
  {
    kind: "completion",
    label: "任务完成",
    description: "当前或后台任务成功完成时，告诉你「做好啦」。",
  },
  {
    kind: "idle",
    label: "无聊时打招呼",
    description:
      "空闲时偶尔说「陪我玩一会儿嘛」；工作、展开窗口、隐藏或睡着时安静。",
  },
];

export function SoundSettings({
  settings,
  onApply,
}: {
  settings?: Settings;
  onApply: (patch: Partial<Settings>) => Promise<any>;
}) {
  const value = normalizeSoundSettings(settings);
  const [volume, setVolume] = useState(value.volume);
  const submittedVolume = useRef(value.volume);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Partial<Settings> | null>(null);
  const busy = pending !== null;
  const sounds = useSounds();
  const auditionRequest = useRef<{
    kind: SoundKind | "preview";
    voice: string;
  } | null>(null);
  const invalidateAudition = (next: Settings) => {
    const request = auditionRequest.current;
    if (
      request &&
      (request.voice !== next.voice ||
        !next.enabled ||
        next.volume === 0 ||
        (request.kind !== "preview" && !next[request.kind]))
    )
      auditionRequest.current = null;
  };
  useEffect(() => {
    invalidateAudition(value);
    // Saving returns before the coalesced state broadcast reaches the player.
    // Keep controls disabled until the new settings are rendered and applied.
    if (
      pending &&
      Object.entries(pending).every(
        ([key, next]) => value[key as keyof Settings] === next,
      )
    )
      setPending(null);
  }, [
    value.voice,
    value.enabled,
    value.volume,
    value.pet,
    value.completion,
    value.idle,
    pending,
  ]);
  useEffect(
    () => () => {
      auditionRequest.current = null;
    },
    [],
  );
  const audition = async (kind: SoundKind | "preview") => {
    const request = { kind, voice: value.voice };
    let result;
    try {
      result = await sounds.preview(value.voice, kind, () => {
        // Busy/muted attempts do not replace a request still awaiting a result.
        auditionRequest.current = request;
        setError("");
      });
    } catch {
      result = "unavailable";
    }
    if (auditionRequest.current !== request) return;
    auditionRequest.current = null;
    if (result === "unavailable")
      setError("暂时无法播放声音，请检查音频文件和系统声音输出后重试。");
  };
  useEffect(() => {
    submittedVolume.current = value.volume;
    setVolume(value.volume);
  }, [value.volume]);
  const apply = async (patch: Partial<Settings>) => {
    invalidateAudition(normalizeSoundSettings({ ...value, ...patch }));
    setPending(patch);
    setError("");
    try {
      await onApply(patch);
    } catch {
      setError("声音设置未保存，请重试。");
      submittedVolume.current = value.volume;
      setVolume(value.volume);
      setPending(null);
    }
  };
  const applyVolume = (next: number) => {
    if (next === submittedVolume.current) return;
    submittedVolume.current = next;
    void apply({ volume: next });
  };
  return (
    <section className="settings-card sound-settings" aria-label="声音设置">
      <div className="toggle-row">
        <div>
          <h2>声音陪伴</h2>
          <p>挑一款喜欢的声线，陪你互动和等待任务。默认音量 35%。</p>
        </div>
        <button
          role="switch"
          aria-checked={value.enabled}
          aria-label="声音陪伴"
          className={`switch ${value.enabled ? "on" : ""}`}
          disabled={busy}
          onClick={() => void apply({ enabled: !value.enabled })}
        >
          <span />
        </button>
      </div>
      <label className="field-label" htmlFor="sound-voice">
        声线
      </label>
      <div className="sound-voice-picker">
        <select
          id="sound-voice"
          value={value.voice}
          disabled={busy}
          aria-describedby="sound-voice-note"
          onChange={(event) => void apply({ voice: event.currentTarget.value })}
        >
          {SOUND_VOICES.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
        <button
          className="secondary sound-preview"
          aria-label="试听当前声线"
          disabled={busy || !value.enabled || volume === 0}
          onClick={() => void audition("preview")}
        >
          <Volume2 size={13} />
          <span>试听</span>
        </button>
      </div>
      <p id="sound-voice-note" className="sound-voice-note">
        {SOUND_VOICES.length} 种声线，选择后自动保存。语音可离线播放。
      </p>
      <div className="sound-volume-heading">
        <label htmlFor="sound-volume">音量</label>
        <output htmlFor="sound-volume">{volume}%</output>
      </div>
      <input
        id="sound-volume"
        className="pet-size-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={volume}
        disabled={!value.enabled || busy}
        aria-valuetext={`${volume}%`}
        onChange={(event) => setVolume(Number(event.currentTarget.value))}
        onPointerUp={(event) => applyVolume(Number(event.currentTarget.value))}
        onPointerCancel={(event) =>
          applyVolume(Number(event.currentTarget.value))
        }
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            applyVolume(Number(event.currentTarget.value));
        }}
        onBlur={(event) => applyVolume(Number(event.currentTarget.value))}
      />
      {events.map(({ kind, label, description }) => (
        <div className="sound-event" key={kind}>
          <div>
            <h3>{label}</h3>
            <p>{description}</p>
          </div>
          <button
            className="secondary sound-preview"
            aria-label={`试听${label}`}
            title={`试听${label}`}
            disabled={
              busy || !value.enabled || !value[kind] || value.volume === 0
            }
            onClick={() => void audition(kind)}
          >
            <Volume2 size={13} />
            <span>试听</span>
          </button>
          <button
            role="switch"
            aria-label={`${label}声音`}
            aria-checked={value[kind]}
            className={`switch ${value[kind] ? "on" : ""}`}
            disabled={busy || !value.enabled}
            onClick={() => void apply({ [kind]: !value[kind] })}
          >
            <span />
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="sound-error">
          {error}
        </p>
      )}
    </section>
  );
}
