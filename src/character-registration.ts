import registration from "../public/characters/deepseek-girl/animations/registration.json";
import { scaleRegistration } from "../shared/character-layout.mjs";

// Previews are rendered at most ~232 physical px tall. 30% of the source keeps
// them sharp at 2x while cutting decoded bitmap memory by roughly 11x.
export const SMALL_SCALE = 0.3;
export const smallRegistration: typeof registration = scaleRegistration(
  registration,
  SMALL_SCALE,
);
