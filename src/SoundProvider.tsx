import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { SoundCues } from "../shared/sound.mjs";
import { PetAudio, type SoundKind } from "./sounds";
import type { AppState } from "./types";

const SoundContext = createContext({
  engage: () => {},
  setSleeping: (_sleeping: boolean) => {},
  play: async (_kind: SoundKind): Promise<string> => "unavailable",
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
        visible && !document.hidden && !sleeping.current,
      );
      engine.refresh();
      for (const kind of next) {
        const idleRevision = policy.idleRevision;
        const completionCue = policy.completionCue;
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
              : policy.completionIsCurrent(
                  current.current.state,
                  Date.now(),
                  completionCue,
                )),
        );
      }
    };
    const visibility = (value: boolean) => {
      visible = value;
      policy.engage();
      tick.current();
    };
    const unsubscribe = window.desktop?.subscribeVisibility?.(visibility);
    void window.desktop
      ?.invoke("visibility")
      .then((value) => {
        if (live) visibility(value);
      })
      .catch(() => {});
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
      unsubscribe?.();
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
      play: async (kind: SoundKind) =>
        (await audio.current?.play(kind)) || "unavailable",
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
