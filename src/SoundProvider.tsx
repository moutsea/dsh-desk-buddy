import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { SoundCues } from "../shared/sound.mjs";
import { PetAudio, type SoundKind } from "./sounds";
import type { AppState } from "./types";

const SoundContext = createContext({
  engage: () => {},
  setSleeping: (_sleeping: boolean) => {},
  play: async (_kind: SoundKind): Promise<string> => "unavailable",
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
      if (!current.current.ready) return;
      const snapshot = current.current.state;
      engine.configure(snapshot.config.sounds);
      for (const kind of policy.update(
        snapshot,
        Date.now(),
        visible && !document.hidden && !sleeping.current,
      ))
        void engine.play(kind as SoundKind);
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
      engage: () => cues.current?.engage(),
      setSleeping: (value: boolean) => {
        sleeping.current = value;
      },
      play: async (kind: SoundKind) =>
        (await audio.current?.play(kind)) || "unavailable",
    }),
    [],
  );
  return (
    <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
  );
}
