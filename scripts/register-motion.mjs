// Analyze alpha only; original ImageGen PNGs are kept unchanged.
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPRESSIONS } from "../shared/expressions.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { analyzeCharacters } from "./analyze-character.mjs";
const fixture = await createFixture(),
  data = await mkdtemp(join(tmpdir(), "deepseek-girl-registration-"));
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({ endpoint: fixture.endpoint, alwaysOnTop: false }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ args: ["."], env });
  let page;
  await expect
    .poll(() => {
      page = desktop.windows().find((p) => p.url().includes("view=pet"));
      return !!page;
    })
    .toBe(true);
  const result = await page.evaluate(
    analyzeCharacters,
    EXPRESSIONS.map((e) => e.id),
  );
  await writeFile(
    "public/characters/deepseek-girl/animations/registration.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    "Registered 76 motion frames and 19 static poses with shared scale and foot anchors.",
  );
} finally {
  await desktop?.close();
  await fixture.close();
  await rm(data, { recursive: true, force: true });
}
