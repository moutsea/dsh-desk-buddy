import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../tests/fixture.mjs";
import { petSize, PET_CHARACTER } from "../shared/desktop-layout.mjs";

const fixture = await createFixture(),
  data = await mkdtemp(join(tmpdir(), "dsg-size-"));
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    alwaysOnTop: false,
    idleExpressions: false,
    petPosition: { x: 500, y: 300 },
  }),
);
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow({ timeout: 15000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktop.invoke("state").then((s) => s.connection),
      ),
    )
    .toBe("connected");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => window.desktop.invoke("section", "settings"));
  const range = page.getByRole("slider", { name: "桌宠大小" }),
    stage = page.locator(".pet-stage"),
    character = page.locator(".pet-character");
  await expect(range).toHaveValue("100");
  const anchor = async () => {
    const state = await page.evaluate(() => window.desktop.invoke("state"));
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    const size = petSize(state.config.petScale);
    return {
      x: bounds.x + state.surface.pet.x + size.width / 2,
      y: bounds.y + state.surface.pet.y + size.height,
    };
  };
  const original = await anchor();
  const verify = async (scale) => {
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktop.invoke("state").then((s) => s.config.petScale),
        ),
      )
      .toBe(scale);
    await expect(stage).toHaveCSS("width", `${petSize(scale).width}px`);
    await expect(stage).toHaveCSS("height", `${petSize(scale).height}px`);
    await expect
      .poll(() =>
        character.evaluate(
          (node, expected) =>
            Math.abs(node.getBoundingClientRect().height - expected),
          (PET_CHARACTER.height * scale) / 100,
        ),
      )
      .toBeLessThan(0.02);
    await expect
      .poll(() =>
        character.evaluate(
          (node, expected) =>
            Math.abs(node.getBoundingClientRect().width - expected),
          (PET_CHARACTER.width * scale) / 100,
        ),
      )
      .toBeLessThan(0.02);
    assert.deepEqual(
      await anchor(),
      original,
      "resize keeps feet and horizontal center stable",
    );
    assert.equal(app.windows().length, 1);
    await expect(page.locator(".companion-surface")).toBeVisible();
  };
  await range.focus();
  await range.press("Home");
  await verify(50);
  const baseBubble = await page
    .locator(".pet-orb")
    .first()
    .evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(
    baseBubble,
    85,
    "bubble targets remain readable at minimum size",
  );
  await range.press("End");
  await verify(150);
  await expect(range).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await verify(145);
  await expect(range).toBeFocused();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await verify(100);
  await expect(range).toHaveValue("100");
  // A real pointer drag holds the settings in place until release, then applies once.
  const track = await range.boundingBox();
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width - 3, track.y + track.height / 2, {
    steps: 10,
  });
  await expect(range).toHaveValue("150");
  assert.equal(
    (await page.evaluate(() => window.desktop.invoke("state"))).config.petScale,
    100,
  );
  await page.mouse.up();
  await verify(150);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/size-settings.png",
    omitBackground: true,
  });
  await page.evaluate(() => window.desktop.invoke("section", null));
  await expect(page.locator(".companion-surface")).not.toBeVisible();
  const collapsed = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.equal(collapsed.width, petSize(150).width);
  assert.equal(collapsed.height, petSize(150).height);
  assert.deepEqual(await anchor(), original);
  // Enlarge at a display edge: clamp the entire transparent surface to the work area.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea,
      w = BrowserWindow.getAllWindows()[0];
    w.setPosition(
      area.x + area.width - w.getBounds().width,
      area.y + area.height - w.getBounds().height,
    );
  });
  await page.evaluate(() => window.desktop.invoke("petScale", 50));
  await page.evaluate(() => window.desktop.invoke("petScale", 150));
  const fit = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    area: screen.getPrimaryDisplay().workArea,
  }));
  assert.ok(
    fit.bounds.x >= fit.area.x &&
      fit.bounds.x + fit.bounds.width <= fit.area.x + fit.area.width,
  );
  assert.ok(
    fit.bounds.y >= fit.area.y &&
      fit.bounds.y + fit.bounds.height <= fit.area.y + fit.area.height,
  );
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke("petScale", 500)),
    /桌宠大小/,
  );
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke("petScale", "50")),
    /桌宠大小/,
  );
  await page.evaluate(() => window.desktop.invoke("petScale", 75));
  await app.close();
  app = null;
  const saved = JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
  assert.equal(saved.petScale, 75);
  app = await launchDesktop(env);
  const restored = await app.firstWindow({ timeout: 15000 });
  await expect(restored.locator(".pet-character")).toHaveCSS(
    "height",
    `${PET_CHARACTER.height * 0.75}px`,
  );
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.equal(bounds.width, petSize(75).width);
  assert.equal(bounds.height, petSize(75).height);
  await restored.evaluate(() => window.desktop.invoke("section", "settings"));
  await expect(restored.getByRole("slider", { name: "桌宠大小" })).toHaveValue(
    "75",
  );
  assert.deepEqual(errors, []);
  console.log(
    "DSG size passed: keyboard and pointer controls, 50–150%, reset, readable bubbles, stable feet, screen edges, collapse and restart persistence.",
  );
} finally {
  await app?.close();
  await fixture.close();
  await rm(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
