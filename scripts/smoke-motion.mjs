import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPRESSIONS } from "../shared/expressions.mjs";
import { MOTIONS, motionDuration } from "../shared/motions.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "deepseek-girl-motion-"));
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    alwaysOnTop: false,
    idleExpressions: false,
  }),
);
const ids =
  process.env.MOTION_SMOKE_IDS?.split(",") || EXPRESSIONS.map((e) => e.id);
let desktop;
try {
  desktop = await launchDesktop(env);
  let pet;
  await expect
    .poll(() => {
      pet = desktop.windows().find((page) => page.url().includes("view=pet"));
      return !!pet;
    })
    .toBe(true);
  assert.ok(pet);
  const errors = [];
  pet.on("pageerror", (error) => errors.push(error.message));
  await mkdir("artifacts/motion", { recursive: true });
  for (const id of ids) {
    await pet.evaluate(
      (expression) => window.desktop.invoke("expression", expression),
      id,
    );
    const sprite = pet.locator(
      `.pet-character .motion-sprite[data-motion="${id}"][data-ready="true"]`,
    );
    await sprite.waitFor();
    await expect(sprite).toHaveAttribute("data-playing", "true");
    // Inspect actual raster cells, not just an animation flag or CSS movement.
    const cells = await sprite.evaluate(async (node) => {
      const source = new Image();
      source.src = node.querySelector("image").href.baseVal;
      await source.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 192;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      return Array.from({ length: 4 }, (_, i) => {
        ctx.clearRect(0, 0, 160, 192);
        ctx.drawImage(
          source,
          ((i % 2) * source.width) / 2,
          (Math.floor(i / 2) * source.height) / 2,
          source.width / 2,
          source.height / 2,
          0,
          0,
          160,
          192,
        );
        const pixels = ctx.getImageData(0, 0, 160, 192).data;
        let count = 0,
          left = 160,
          right = 0,
          top = 192,
          bottom = 0,
          hash = 2166136261;
        for (let p = 0; p < pixels.length; p += 4) {
          hash = Math.imul(
            hash ^ pixels[p] ^ pixels[p + 1] ^ pixels[p + 2] ^ pixels[p + 3],
            16777619,
          );
          if (pixels[p + 3] > 32) {
            const x = (p / 4) % 160,
              y = Math.floor(p / 4 / 160);
            count++;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
        return {
          count,
          left,
          right,
          top,
          bottom,
          hash,
          corners: [
            pixels[3],
            pixels[(160 - 1) * 4 + 3],
            pixels[(192 - 1) * 160 * 4 + 3],
            pixels[pixels.length - 1],
          ],
        };
      });
    });
    assert.equal(
      new Set(cells.map((cell) => cell.hash)).size,
      4,
      `${id}: four distinct drawn frames`,
    );
    assert.ok(
      cells.every(
        (cell) =>
          cell.count > 7000 && cell.corners.every((alpha) => alpha === 0),
      ),
      `${id}: visible figure on true transparency`,
    );
    assert.ok(
      Math.max(...cells.map((c) => c.bottom)) -
        Math.min(...cells.map((c) => c.bottom)) <
        16,
      `${id}: feet remain registered`,
    );
    const image = sprite.locator("image");
    await image.evaluate((node) => {
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
    });
    const first = await pet
      .locator(".pet-character .mascot")
      .screenshot({ omitBackground: true, animations: "allow" });
    await image.evaluate((node, time) => {
      node.getAnimations()[0].currentTime = time;
    }, MOTIONS[id].sequence[0][1] + 5);
    const second = await pet
      .locator(".pet-character .mascot")
      .screenshot({ omitBackground: true, animations: "allow" });
    assert.ok(
      !first.equals(second),
      `${id}: rendered internal pose really changes`,
    );
    if (["idle", "working", "learning", "celebrating"].includes(id)) {
      await writeFile(`artifacts/motion/${id}-a.png`, first);
      await writeFile(`artifacts/motion/${id}-b.png`, second);
    }
    await image.evaluate((node) => node.getAnimations()[0].play());
    console.log(`Motion verified: ${id} (${motionDuration(id)} ms)`);
  }
  const sprite = pet.locator(".pet-character .motion-sprite.ready"),
    image = sprite.locator("image");
  await pet.emulateMedia({ reducedMotion: "reduce" });
  await expect(sprite).toHaveAttribute("data-playing", "false");
  assert.equal(
    await image.evaluate((node) => node.getAnimations()[0].currentTime),
    0,
  );
  await pet.emulateMedia({ reducedMotion: "no-preference" });
  await expect(sprite).toHaveAttribute("data-playing", "true");
  await pet.evaluate(() => window.desktop.invoke("animations", false));
  await expect(sprite).toHaveAttribute("data-playing", "false");
  assert.equal(
    await pet
      .locator(".pet-character .mascot")
      .evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      ),
    0,
    "user toggle also stops decorative effects",
  );
  assert.equal(
    await image.evaluate((node) => node.getAnimations()[0].currentTime),
    0,
  );
  await pet.evaluate(() => window.desktop.invoke("animations", true));
  await expect(sprite).toHaveAttribute("data-playing", "true");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle().includes("桌宠"))
      .hide(),
  );
  await expect(sprite).toHaveAttribute("data-playing", "false");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle().includes("桌宠"))
      .showInactive(),
  );
  await expect(sprite).toHaveAttribute("data-playing", "true");
  assert.deepEqual(errors, []);
  console.log(
    `Animation UI passed: ${ids.length} drawn loops, actual frame changes, transparency, reduced motion, user toggle and hidden-window pause.`,
  );
} finally {
  await desktop?.close();
  await fixture.close();
  await rm(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
