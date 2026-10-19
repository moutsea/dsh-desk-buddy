import { useEffect, useState } from "react";
import { PET_SCALE } from "../shared/desktop-layout.mjs";

export function PetSizeSetting({
  scale,
  onApply,
}: {
  scale: number;
  onApply: (value: number) => Promise<any>;
}) {
  const [value, setValue] = useState(scale);
  useEffect(() => setValue(scale), [scale]);
  const apply = (next: number) => {
    void onApply(next);
  };
  return (
    <section className="settings-card pet-size-setting">
      <div className="pet-size-heading">
        <h2>
          <label htmlFor="pet-size">桌宠大小</label>
          <output htmlFor="pet-size">{value}%</output>
        </h2>
        <button
          className="secondary"
          disabled={value === PET_SCALE.default}
          onClick={() => {
            setValue(PET_SCALE.default);
            apply(PET_SCALE.default);
          }}
        >
          恢复默认
        </button>
      </div>
      <p>松开滑块后调整角色大小，重启后也会记住。</p>
      <input
        id="pet-size"
        className="pet-size-range"
        type="range"
        min={PET_SCALE.min}
        max={PET_SCALE.max}
        step={PET_SCALE.step}
        value={value}
        aria-valuetext={`${value}%`}
        onChange={(event) => setValue(Number(event.currentTarget.value))}
        onPointerUp={(event) => apply(Number(event.currentTarget.value))}
        onPointerCancel={(event) => apply(Number(event.currentTarget.value))}
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
            apply(Number(event.currentTarget.value));
        }}
        onBlur={(event) => apply(Number(event.currentTarget.value))}
      />
      <div className="pet-size-limits">
        <span>小巧 · {PET_SCALE.min}%</span>
        <span>显眼 · {PET_SCALE.max}%</span>
      </div>
    </section>
  );
}
