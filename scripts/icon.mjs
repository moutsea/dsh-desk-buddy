import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const width = character.readUInt32BE(16);
const height = character.readUInt32BE(20);
const silhouette = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <filter id="silhouette" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
      <feComponentTransfer><feFuncA type="discrete" tableValues="0 1"/></feComponentTransfer>
    </filter>
    <image href="data:image/png;base64,${character.toString("base64")}" width="${width}" height="${height}" filter="url(#silhouette)"/>
  </svg>`,
)
  .render()
  .asPng();
await mkdir(new URL("../electron/assets/", import.meta.url), {
  recursive: true,
});
for (const [name, size, color] of [
  ["trayTemplate.png", 18, "#000000"],
  ["trayTemplate@2x.png", 36, "#000000"],
  ["tray.png", 32, "#4364d6"],
]) {
  const samples = 8;
  const pixels = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 18 18">
      <image href="data:image/png;base64,${silhouette.toString("base64")}" x="1" y="1" width="16" height="16"/>
    </svg>`,
    { fitTo: { mode: "zoom", value: samples } },
  ).render().pixels;
  const cells = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let alpha = 0;
      for (let sampleRow = 0; sampleRow < samples; sampleRow++)
        for (let sampleColumn = 0; sampleColumn < samples; sampleColumn++)
          alpha +=
            pixels[
              ((row * samples + sampleRow) * size * samples +
                column * samples +
                sampleColumn) *
                4 +
                3
            ];
      if (alpha)
        cells.push(
          `<rect x="${column}" y="${row}" width="1" height="1" fill-opacity="${alpha / (samples * samples * 255)}"/>`,
        );
    }
  }
  const icon = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="${color}">${cells.join("")}</svg>`,
  )
    .render()
    .asPng();
  await writeFile(new URL(`../electron/assets/${name}`, import.meta.url), icon);
}
