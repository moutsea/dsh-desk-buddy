import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { SoundCues } from "../shared/sound.mjs";
import { observeWindowVisibility } from "../shared/window-visibility.mjs";
import { PetAudio, type SoundKind } from "./sounds";
import type { AppState } from "./types";

const SoundContext = createContext({
  engage: () => {},
  setSleeping: (_sleeping: boolean) => {},
  play: async (_kind: SoundKind, _isCurrent?: () => boolean): Promise<string> =>
    "unavailable",
  preview: async (
    _voice: string,
    _kind: SoundKind | "preview" = "preview",
    onAccepted?: () => void,
  ): Promise<string> => {
    onAccepted?.();
    return "unavailable";
  },
});

export const useSounds = () => useContext(SoundContext);

export function SoundProvider({
  state,
  ready,
  children,
}: {
  state: AppState;
  ready: boolean;
  children: React.ReactNode;
}) {
  const current = useRef({ state, ready });
  current.current = { state, ready };
  const audio = useRef<PetAudio | null>(null);
  const cues = useRef<SoundCues | null>(null);
  const sleeping = useRef(false);
  const visibleWindow = useRef(!document.hidden);
  const tick = useRef(() => {});
  useEffect(() => {
    const engine = new PetAudio();
    const policy = new SoundCues();
    audio.current = engine;
    cues.current = policy;
    let visible = !document.hidden;
    let live = true;
    tick.current = () => {
      if (!current.current.ready) {
        engine.refresh();
        return;
      }
      const snapshot = current.current.state;
      engine.configure(snapshot.config.sounds);
      const next = policy.update(
        snapshot,
        Date.now(),
        visible && !document.hidden,
        !sleeping.current,
      );
      engine.refresh();
      for (const kind of next) {
        const idleRevision = policy.idleRevision;
        const completionCue = policy.completionCue;
        const taskCue = policy.taskCues[kind];
        const reconnectCue = policy.reconnection.cue;
        void engine.play(
          kind as SoundKind,
          () =>
            live &&
            current.current.ready &&
            (kind === "idle"
              ? policy.idleIsCurrent(
                  current.current.state,
                  Date.now(),
                  visible && !document.hidden && !sleeping.current,
                  idleRevision,
                )
              : kind === "completion"
                ? policy.completionIsCurrent(
                    current.current.state,
                    Date.now(),
                    completionCue,
                  )
                : kind === "reconnected"
                  ? policy.reconnection.isCurrent(
                      current.current.state,
                      Date.now(),
                      visible && !document.hidden,
                      reconnectCue,
                    )
                  : policy.taskIsCurrent(
                      current.current.state,
                      Date.now(),
                      taskCue,
                    )),
        );
      }
    };
    const visibility = (value: boolean) => {
      visible = value;
      visibleWindow.current = value;
      policy.engage();
      tick.current();
    };
    const unsubscribe = observeWindowVisibility(window.desktop, visibility);
    const changed = () => {
      policy.engage();
      tick.current();
    };
    document.addEventListener("visibilitychange", changed);
    tick.current();
    const timer = setInterval(() => tick.current(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", changed);
      tick.current = () => {};
      audio.current = null;
      cues.current = null;
      engine.dispose();
    };
  }, []);
  useEffect(() => tick.current(), [state, ready]);
  const value = useMemo(
    () => ({
      engage: () => {
        cues.current?.engage();
        audio.current?.refresh();
      },
      setSleeping: (value: boolean) => {
        sleeping.current = value;
        tick.current();
      },
      play: async (kind: SoundKind, isCurrent?: () => boolean) =>
        (await audio.current?.play(
          kind,
          () =>
            current.current.ready &&
            visibleWindow.current &&
            !document.hidden &&
            (isCurrent?.() ?? true),
        )) || "unavailable",
      preview: async (
        voice: string,
        kind: SoundKind | "preview" = "preview",
        onAccepted?: () => void,
      ) => {
        if (audio.current)
          return audio.current.preview(voice, kind, onAccepted);
        onAccepted?.();
        return "unavailable";
      },
    }),
    [],
  );
  return (
    <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
  );
}
