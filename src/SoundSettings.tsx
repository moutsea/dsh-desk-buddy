import { useEffect, useRef, useState } from "react";
import { ChevronRight, SlidersHorizontal, Volume2, X } from "lucide-react";
import { normalizeSoundSettings } from "../shared/sound.mjs";
import { SOUND_VOICES } from "../shared/voices.mjs";
import { useSounds } from "./SoundProvider";
import type { SoundSettings as Settings, SoundKind } from "./sounds";

const events: { kind: SoundKind; label: string; description: string }[] = [
  {
    kind: "pet",
    label: "摸摸桌宠",
    description: "轻点角色时轻声回应，三句台词轮换。",
  },
  {
    kind: "angry",
    label: "连点小脾气",
    description: "连点惹她生气时说「慢一点啦，哼！」；持续连点不重复说。",
  },
  {
    kind: "shy",
    label: "害羞回应",
    description: "停留看她 8 秒，轻声说「一直看着我做什么呀……」。",
  },
  {
    kind: "wake",
    label: "点击叫醒",
    description: "点醒睡着的她时说「唔……我醒啦」。",
  },
  {
    kind: "moved",
    label: "搬家回应",
    description: "拖到新位置放下时说「这里也不错嘛」。默认关闭。",
  },
  {
    kind: "sleep",
    label: "准备睡觉",
    description: "闲置入睡时说「有点困了，我眯一会儿哦」。默认关闭。",
  },
  {
    kind: "welcome",
    label: "久别欢迎",
    description:
      "10 分钟没互动后再点她，说「你回来啦，我在呢」；与叫醒只说一句。",
  },
  {
    kind: "reconnected",
    label: "重新连上",
    description: "断线超过 10 秒、恢复稳定后说「又连上啦」。默认关闭。",
  },
  {
    kind: "completion",
    label: "任务完成",
    description: "当前或后台任务成功完成时轻声报喜，三句台词轮换。",
  },
  {
    kind: "started",
    label: "开始任务",
    description: "接到新任务时轻声回应，三句台词轮换。默认关闭。",
  },
  {
    kind: "attention",
    label: "需要你回应",
    description: "有审批或提问等待处理时轻声提醒，三句台词轮换。",
  },
  {
    kind: "failure",
    label: "任务出错",
    description: "任务失败时温柔提醒，三句台词轮换。主动停止不提醒。",
  },
  {
    kind: "idle",
    label: "无聊时打招呼",
    description:
      "空闲时偶尔打招呼，三句台词轮换；工作、展开窗口、隐藏或睡着时安静。",
  },
];

const groups = [
  {
    id: "interaction",
    title: "互动回应",
    kinds: ["pet", "angry", "shy", "wake", "moved"],
  },
  {
    id: "companionship",
    title: "日常陪伴",
    kinds: ["idle", "sleep", "welcome"],
  },
  {
    id: "tasks",
    title: "任务与连接",
    kinds: ["completion", "started", "attention", "failure", "reconnected"],
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
  const [eventsOpen, setEventsOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
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
    value.angry,
    value.completion,
    value.idle,
    value.started,
    value.attention,
    value.failure,
    value.shy,
    value.wake,
    value.sleep,
    value.welcome,
    value.moved,
    value.reconnected,
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
        {SOUND_VOICES.length}{" "}
        种声线，选择后自动保存。语音可离线播放，标有轮换的场景可多次试听不同台词。
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
      <button
        className="sound-events-entry"
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          setEventsOpen(true);
        }}
      >
        <SlidersHorizontal size={16} />
        <span>
          <strong>互动声音设置</strong>
          <small>
            已开启 {events.filter(({ kind }) => value[kind]).length} /{" "}
            {events.length} 个场景
          </small>
        </span>
        <ChevronRight size={16} />
      </button>
      <dialog
        ref={dialog}
        className="sound-events-dialog"
        aria-labelledby="sound-events-title"
        aria-describedby="sound-events-note"
        onClose={() => setEventsOpen(dialog.current?.open ?? false)}
        onKeyDown={(event) => {
          // Let the native dialog handle Escape without closing the settings page.
          if (event.key === "Escape") event.stopPropagation();
        }}
        onPointerDown={(event) => {
          backdropPress.current = !(event.target as Element).closest(
            ".sound-dialog-panel",
          );
        }}
        onPointerCancel={() => {
          backdropPress.current = false;
        }}
        onClick={(event) => {
          if (
            backdropPress.current &&
            !(event.target as Element).closest(".sound-dialog-panel")
          )
            dialog.current?.close();
          backdropPress.current = false;
        }}
      >
        <div className="sound-dialog-shade">
          <section className="settings-card sound-dialog-panel">
            <header className="sound-dialog-heading">
              <div>
                <h2 id="sound-events-title">互动声音设置</h2>
                <p id="sound-events-note">
                  {value.enabled
                    ? "按场景选择声音，更改自动保存。"
                    : "声音陪伴已关闭，请先在设置页打开总开关。"}
                </p>
              </div>
              <button
                className="sound-dialog-close"
                aria-label="关闭互动声音设置"
                autoFocus
                onClick={() => dialog.current?.close()}
              >
                <X size={17} />
              </button>
            </header>
            <div className="sound-dialog-body">
              {groups.map((group) => (
                <div
                  className="sound-group"
                  data-sound-group={group.id}
                  key={group.id}
                >
                  <h2>{group.title}</h2>
                  {group.kinds
                    .map((kind) => events.find((item) => item.kind === kind)!)
                    .map(({ kind, label, description }) => (
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
                            busy ||
                            !value.enabled ||
                            !value[kind] ||
                            value.volume === 0
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
                </div>
              ))}
            </div>
            {error && eventsOpen && (
              <p role="alert" className="sound-error">
                {error}
              </p>
            )}
          </section>
        </div>
      </dialog>
      {error && !eventsOpen && (
        <p role="alert" className="sound-error">
          {error}
        </p>
      )}
    </section>
  );
}
