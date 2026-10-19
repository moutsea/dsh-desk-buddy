import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../tests/fixture.mjs";
import { petSize } from "../shared/desktop-layout.mjs";
const fixture = await createFixture(),
  data = await mkdtemp(join(tmpdir(), "dsg-drag-"));
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
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktop.invoke("state").then((s) => s.connection),
      ),
    )
    .toBe("connected");
  const pet = page.locator(".pet-character"),
    stage = page.locator(".pet-stage");
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  const anchor = async () => {
    const s = await state(),
      b = await bounds();
    return { x: b.x + s.surface.pet.x, y: b.y + s.surface.pet.y };
  };
  const invoke = (action, payload) =>
    page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  await page.evaluate(() => {
    window.dragClicks = [];
    document.addEventListener("click", (event) => {
      if (event.target.closest(".pet-character"))
        window.dragClicks.push(event.defaultPrevented);
    });
  });
  const start = async () => {
    const box = await pet.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    return point;
  };
  const move = async (dx, dy) => {
    const clickCount = await page.evaluate(() => window.dragClicks.length);
    const lastInteractionAt = (await state()).lastInteractionAt;
    const before = await anchor(),
      point = await start();
    await page.mouse.move(point.x + dx, point.y + dy);
    await expect(stage).toHaveClass(/is-dragging/);
    await expect.poll(anchor).toEqual({ x: before.x + dx, y: before.y + dy });
    await expect(page.locator(".pet-hover-controls")).not.toBeVisible();
    await page.mouse.up();
    await expect(stage).not.toHaveClass(/is-dragging/);
    await expect
      .poll(async () => (await state()).config.petPosition)
      .toEqual({ x: before.x + dx, y: before.y + dy });
    assert.ok(
      (await page.evaluate(() => window.dragClicks))
        .slice(clickCount)
        .every(Boolean),
      "any click emitted by drag release is suppressed",
    );
    assert.equal(
      (await state()).lastInteractionAt,
      lastInteractionAt,
      "drag release does not pet the character",
    );
  };
  assert.equal(
    await page.locator(".pet-drag").count(),
    0,
    "no hidden handle needed",
  );
  await move(48, -36);
  await expect(pet.locator(".mascot")).toHaveAttribute(
    "data-expression",
    "idle",
  );
  const beforeClick = await anchor(),
    point = await start();
  await page.mouse.move(point.x + 2, point.y + 2);
  await page.mouse.up();
  assert.deepEqual(
    await anchor(),
    beforeClick,
    "small hand jitter remains a click",
  );
  assert.equal((await page.evaluate(() => window.dragClicks)).at(-1), false);
  await pet.locator('[data-expression="love"]').waitFor();
  // Open content must follow the pet and can switch sides without dropping the input draft.
  await invoke("section", "chat");
  await page.getByRole("textbox", { name: "消息" }).fill("拖动后保留的草稿");
  const area = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().workArea,
  );
  const before = await anchor(),
    target = {
      x: area.x + area.width - petSize(100).width - 20,
      y: area.y + 35,
    };
  await move(target.x - before.x, target.y - before.y);
  await expect(page.locator(".desktop-stage")).toHaveAttribute(
    "data-side",
    "left",
  );
  await expect(page.locator(".companion-surface")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue(
    "拖动后保留的草稿",
  );
  assert.equal(app.windows().length, 1);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/drag-content.png",
    omitBackground: true,
  });
  const moved = await anchor();
  await invoke("section", null);
  assert.deepEqual(await anchor(), moved);
  for (const scale of [50, 150]) {
    await invoke("petScale", scale);
    await expect(pet).toHaveCSS("height", `${(270 * scale) / 100}px`);
    await move(-30, 25);
  }
  // Losing pointer capture must release the drag lock and leave the last position intact.
  const cancelBefore = await anchor(),
    cancel = await start();
  await page.mouse.move(cancel.x - 20, cancel.y + 10);
  await expect
    .poll(anchor)
    .toEqual({ x: cancelBefore.x - 20, y: cancelBefore.y + 10 });
  await pet.dispatchEvent("pointercancel", { pointerId: 1 });
  await expect(stage).not.toHaveClass(/is-dragging/);
  await page.mouse.up();
  // Reversing to the press point after crossing the threshold must restore the original position.
  const origin = await anchor();
  await invoke("drag:start", { x: 100, y: 100 });
  await invoke("drag:move", { x: 120, y: 120 });
  await invoke("drag:move", { x: 100, y: 100 });
  await invoke("drag:end");
  assert.deepEqual(await anchor(), origin);
  await invoke("drag:start", { x: 100, y: 100 });
  await invoke("drag:move", { x: -9999, y: -9999 });
  await invoke("drag:end");
  const edge = await bounds();
  assert.ok(edge.x >= area.x && edge.y >= area.y);
  assert.ok(
    edge.x + edge.width <= area.x + area.width &&
      edge.y + edge.height <= area.y + area.height,
  );
  await assert.rejects(invoke("drag:start", { x: "1", y: 1 }), /拖动位置/);
  await assert.rejects(invoke("drag:move", { x: NaN, y: 0 }), /拖动位置/);
  const final = await anchor();
  await app.close();
  app = null;
  const saved = JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
  assert.deepEqual(saved.petPosition, final);
  app = await launchDesktop(env);
  await app.firstWindow();
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.equal(restored.x, final.x);
  assert.equal(restored.y, final.y);
  assert.deepEqual(errors, []);
  console.log(
    "DSG drag passed: direct pointer movement, click/jitter separation, attached content, side changes, 50%/150% sizes, capture cancellation, reversal, screen boundaries and restored position.",
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
