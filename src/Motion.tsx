import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  MOTIONS,
  motionDuration,
  motionKeyframes,
} from "../shared/motions.mjs";
import registration from "../public/characters/deepseek-girl/animations/registration.json";
import { CHARACTER_LAYOUT } from "../shared/character-layout.mjs";
import { observeWindowVisibility } from "../shared/window-visibility.mjs";

export const MotionContext = createContext(true);
const characterRoot = `${import.meta.env.BASE_URL}characters/deepseek-girl/`;

export function MotionSprite({ expression }: { expression: string }) {
  const clipId = useId().replace(/:/g, "");
  const enabled = useContext(MotionContext);
  const root = useRef<SVGSVGElement>(null);
  const picture = useRef<SVGImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const [windowVisible, setWindowVisible] = useState(true);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [sheet, setSheet] = useState<{
    id: string;
    width: number;
    height: number;
  } | null>(null);
  const [animation, setAnimation] = useState<Animation | null>(null);
  const ready = sheet?.id === expression;
  const playing =
    ready && enabled && !reduced && visible && foreground && windowVisible;

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    if (root.current) observer.observe(root.current);
    const visibility = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    // The first show event can occur between render and effect setup.
    visibility();
    const unsubscribe = observeWindowVisibility(
      window.desktop,
      setWindowVisible,
    );
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    change();
    return () => {
      unsubscribe();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", change);
    };
  }, []);

  useEffect(() => {
    if (
      !visible ||
      sheet?.id === expression ||
      !Object.hasOwn(MOTIONS, expression)
    )
      return;
    let live = true;
    const image = new Image();
    image.src = `${characterRoot}animations/${expression}.png`;
    image
      .decode()
      .then(() => {
        if (live)
          setSheet({
            id: expression,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
      })
      .catch(() => {
        if (live) setSheet(null);
      });
    return () => {
      live = false;
    };
  }, [expression, visible, sheet?.id]);

  useEffect(() => {
    if (!ready || !sheet || !picture.current) return;
    const motion = picture.current.animate(
      motionKeyframes(
        expression,
        sheet.width,
        sheet.height,
        registration[expression as keyof typeof registration],
      ),
      {
        duration: motionDuration(expression),
        iterations: Infinity,
      },
    );
    motion.pause();
    motion.currentTime = 0;
    setAnimation(motion);
    return () => motion.cancel();
  }, [expression, ready, sheet]);

  useEffect(() => {
    if (!animation) return;
    if (playing) animation.play();
    else {
      animation.pause();
      if (!enabled || reduced) animation.currentTime = 0;
    }
  }, [animation, playing, enabled, reduced]);

  return (
    <svg
      ref={root}
      className={`motion-sprite ${ready ? "ready" : ""}`}
      viewBox={`0 0 ${CHARACTER_LAYOUT.width} ${CHARACTER_LAYOUT.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      data-motion={expression}
      data-ready={ready ? "true" : "false"}
      data-playing={playing ? "true" : "false"}
    >
      {ready && sheet && (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect
                width={CHARACTER_LAYOUT.width}
                height={CHARACTER_LAYOUT.height}
              />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <image
              ref={picture}
              href={`${characterRoot}animations/${expression}.png`}
              width={sheet.width}
              height={sheet.height}
            />
          </g>
        </>
      )}
    </svg>
  );
}
