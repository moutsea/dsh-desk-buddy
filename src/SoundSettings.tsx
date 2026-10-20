import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { normalizeSoundSettings } from "../shared/sound.mjs";
import { useSounds } from "./SoundProvider";
import type { SoundSettings as Settings, SoundKind } from "./sounds";

const events: { kind: SoundKind; label: string; description: string }[] = [
  {
    kind: "pet",
    label: "摸摸桌宠",
    description: "轻点角色时，回应一声轻巧的啾啾。",
  },
  {
    kind: "completion",
    label: "任务完成",
    description: "当前或后台任务成功完成时，响起一小段庆祝音。",
  },
  {
    kind: "idle",
    label: "无聊时打招呼",
    description: "空闲一段时间后偶尔轻响；工作、展开窗口、隐藏或睡着时安静。",
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
  const [busy, setBusy] = useState(false);
  const sounds = useSounds();
  useEffect(() => {
    submittedVolume.current = value.volume;
    setVolume(value.volume);
  }, [value.volume]);
  const apply = async (patch: Partial<Settings>) => {
    setBusy(true);
    setError("");
    try {
      await onApply(patch);
    } catch {
      setError("声音设置未保存，请重试。");
      submittedVolume.current = value.volume;
      setVolume(value.volume);
    } finally {
      setBusy(false);
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
          <p>轻柔的短提示音，陪你互动和等待任务。默认音量 35%。</p>
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
            onClick={async () => {
              setError("");
              if ((await sounds.play(kind)) === "unavailable")
                setError("暂时无法播放声音，请检查系统声音输出后重试。");
            }}
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
