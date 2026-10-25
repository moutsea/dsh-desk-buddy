import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { launchDesktop, settleDesktopGeometry } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const directory = await mkdtemp(join(tmpdir(), "dsg-expand-"));
const reports = [];
let desktop;
try {
  for (const scenario of [
    { firstSection: "chat", corner: "bottom-right", petScale: 100 },
    { firstSection: "settings", corner: "bottom-right", petScale: 100 },
    { firstSection: "chat", corner: "top-left", petScale: 50 },
    { firstSection: "settings", corner: "top-left", petScale: 150 },
  ]) {
    const { firstSection, corner, petScale } = scenario;
    const data = join(directory, `${firstSection}-${corner}`);
    await mkdir(data);
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        alwaysOnTop: false,
        idleExpressions: false,
        animations: false,
        petScale,
        ...(corner === "top-left" ? { petPosition: { x: 30, y: 50 } } : {}),
      }),
    );
    const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await launchDesktop(env);
    const page = await desktop.firstWindow();
    await page.bringToFront();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktop.invoke("state").then((state) => state.connection),
        ),
      )
      .toBe("connected");
    await expect(
      page.locator(".pet-character .motion-sprite.ready"),
    ).toHaveCount(1);
    await settleDesktopGeometry(desktop);
    const originalBounds = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.expansionGeometry = [];
      globalThis.expansionHidden = false;
      globalThis.expansionBoundsRequests = [];
      const setBounds = window.setBounds.bind(window);
      window.setBounds = (...args) => {
        globalThis.expansionBoundsRequests.push(args[0]);
        return setBounds(...args);
      };
      window.on("hide", () => {
        globalThis.expansionHidden = true;
      });
      globalThis.expansionTimer = setInterval(
        () => globalThis.expansionGeometry.push(window.getBounds()),
        8,
      );
    });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await page.evaluate(() => {
      window.expansionFrames = [];
      window.expansionRecording = true;
      const sample = () => {
        const node = document.querySelector(".pet-character");
        const bounds = node.getBoundingClientRect();
        window.expansionFrames.push({
          x: window.screenX + bounds.x,
          y: window.screenY + bounds.y,
          width: bounds.width,
          height: bounds.height,
          visible:
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight &&
            getComputedStyle(node).visibility === "visible",
        });
        if (window.expansionRecording) requestAnimationFrame(sample);
      };
      sample();
    });
    for (const section of [
      firstSection,
      null,
      firstSection,
      "expressions",
      "chat",
      "settings",
      null,
    ]) {
      await page.evaluate(
        (value) => window.desktop.invoke("section", value),
        section,
      );
      if (section)
        await expect(page.locator(".companion-surface")).toHaveAttribute(
          "data-section",
          section,
        );
      else await expect(page.locator(".companion-surface")).not.toBeVisible();
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let remaining = 8;
            const next = () =>
              --remaining ? requestAnimationFrame(next) : resolve();
            requestAnimationFrame(next);
          }),
      );
      if (section === firstSection) {
        await mkdir("artifacts", { recursive: true });
        await page.screenshot({
          path: `artifacts/expand-${firstSection}-${corner}.png`,
          omitBackground: true,
        });
      }
    }
    const frames = await page.evaluate(() => {
      window.expansionRecording = false;
      return window.expansionFrames;
    });
    const native = await desktop.evaluate(() => {
      clearInterval(globalThis.expansionTimer);
      return {
        bounds: globalThis.expansionGeometry,
        hidden: globalThis.expansionHidden,
        requests: globalThis.expansionBoundsRequests,
      };
    });
    reports.push({ ...scenario, originalBounds, frames, native });
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/expand-frames.json",
      JSON.stringify(reports, null, 2),
    );
    assert.ok(frames.length >= 50);
    assert.ok(
      frames.every(
        (frame) => JSON.stringify(frame) === JSON.stringify(frames[0]),
      ),
      "pet stays visible at the same screen position in every sampled frame",
    );
    assert.ok(frames.every((frame) => frame.visible));
    assert.ok(
      native.bounds.every(
        (bounds) =>
          bounds.x === originalBounds.x && bounds.y === originalBounds.y,
      ),
      "opening, switching and closing never move the native window",
    );
    assert.deepEqual(
      native.requests,
      [],
      "panel changes never request a native move or resize",
    );
    assert.equal(
      native.hidden,
      false,
      "the pet is never hidden to mask a layout change",
    );
    assert.equal(desktop.windows().length, 1);
    await session.detach();
    await desktop.close();
    desktop = null;
  }
  console.log(
    "Expansion passed: first chat/settings open, repeat open, switch and collapse preserve every sampled pet frame and native bounds under CPU throttling.",
  );
} finally {
  await desktop?.close();
  await fixture.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
