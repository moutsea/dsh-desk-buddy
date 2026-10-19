import { useContext, useEffect, useState } from "react";
import { MotionContext, MotionSprite } from "./Motion";
import registration from "../public/characters/deepseek-girl/animations/registration.json";
import {
  CHARACTER_LAYOUT,
  characterPose,
} from "../shared/character-layout.mjs";
import {
  EXPRESSIONS,
  expressionForMood,
  isExpressionId,
} from "../shared/expressions.mjs";
const characterRoot = `${import.meta.env.BASE_URL}characters/deepseek-girl/`;

export function Mascot({
  mood = "idle",
  small = false,
  expression,
}: {
  mood?: string;
  small?: boolean;
  expression?: string;
}) {
  const enabled = useContext(MotionContext);
  const desired = isExpressionId(expression)
    ? expression!
    : expressionForMood(mood);
  const [frame, setFrame] = useState("idle");
  useEffect(() => {
    let live = true;
    const image = new Image();
    image.src = `${characterRoot}${desired}.png`;
    image
      .decode()
      .then(() => {
        if (live) setFrame(desired);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [desired]);
  const label = EXPRESSIONS.find((item) => item.id === frame)?.label || "待机";
  const still = registration[frame as keyof typeof registration].static;
  return (
    <div
      className={`mascot mood-${mood} expression-${frame} ${small ? "small" : ""} ${enabled ? "" : "motion-disabled"}`}
      role="img"
      aria-label={`dsh-desk-buddy · ${label}`}
      data-expression={frame}
    >
      <span className="character-ground" aria-hidden="true" />
      <div className="pet-body" aria-hidden="true">
        <svg
          className="character-image is-active"
          viewBox={`0 0 ${CHARACTER_LAYOUT.width} ${CHARACTER_LAYOUT.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <image
            href={`${characterRoot}${frame}.png`}
            width={still.width}
            height={still.height}
            style={{ transform: characterPose(still).transform }}
          />
        </svg>
        <MotionSprite expression={frame} />
      </div>
      {mood === "waiting" && (
        <span className="character-notice" aria-hidden="true">
          !
        </span>
      )}
      {["done", "celebrating"].includes(mood) && (
        <span className="character-sparkle" aria-hidden="true">
          ✦
        </span>
      )}
      {mood === "celebrating" && (
        <>
          <span className="celebration-spark left" aria-hidden="true">
            ✧
          </span>
          <span className="celebration-spark right" aria-hidden="true">
            ✦
          </span>
        </>
      )}
    </div>
  );
}
