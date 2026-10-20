import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";
const character = await readFile(
  new URL("../public/characters/deepseek-girl/idle.png", import.meta.url),
);
const svg = (
  await readFile(new URL("../build/icon.svg", import.meta.url), "utf8")
).replace(
  "{{CHARACTER}}",
  `data:image/png;base64,${character.toString("base64")}`,
);
await writeFile(
  new URL("../build/icon.png", import.meta.url),
  new Resvg(svg).render().asPng(),
);
await writeFile(
  new URL("../plugins/dsh-girl/web/icon.png", import.meta.url),
  new Resvg(svg, { fitTo: { mode: "width", value: 128 } }).render().asPng(),
);
