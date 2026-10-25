import { _electron as electron } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { powershell } from "../plugins/dsh-girl/archive.mjs";

// macOS changes the work area while the Dock settles after app startup. Take
// geometry baselines only once both the display and the test window settle;
// bounds assertions during the scenario itself remain strict.
export async function settleDesktopGeometry(app) {
  let previous,
    since = Date.now();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await app.evaluate(({ BrowserWindow, screen }) =>
      JSON.stringify({
        areas: screen.getAllDisplays().map((display) => display.workArea),
        bounds: BrowserWindow.getAllWindows()[0].getBounds(),
      }),
    );
    if (value !== previous) {
      previous = value;
      since = Date.now();
    }
    if (Date.now() - since >= 1000) return;
    await delay(100);
  }
  throw new Error("desktop geometry did not settle before the test");
}

// CDP coordinates and the real Windows cursor can disagree when a transparent
// window switches click-through. Synchronize both before asserting hover, so
// native leave events cannot undo CDP input at another screen position.
export async function moveDesktopPointer(app, page, x, y, options = {}) {
  if (process.platform !== "win32") return page.mouse.move(x, y, options);
  const point = await app.evaluate(
    ({ BrowserWindow, screen }, { x, y }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const bounds = window.getBounds();
      const zoom = window.webContents.getZoomFactor();
      return {
        ...screen.dipToScreenPoint({
          x: Math.round(bounds.x + x * zoom),
          y: Math.round(bounds.y + y * zoom),
        }),
        start: screen.dipToScreenPoint(screen.getCursorScreenPoint()),
      };
    },
    { x, y },
  );
  await powershell(
    `
    Add-Type -TypeDefinition '
    using System.Runtime.InteropServices;
    public class DSGPointer {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    }';
    $steps = [int]$env:DSG_MOUSE_STEPS;
    for ($i = 1; $i -le $steps; $i++) {
      $x = [int]$env:DSG_MOUSE_START_X + ([int]$env:DSG_MOUSE_X - [int]$env:DSG_MOUSE_START_X) * $i / $steps;
      $y = [int]$env:DSG_MOUSE_START_Y + ([int]$env:DSG_MOUSE_Y - [int]$env:DSG_MOUSE_START_Y) * $i / $steps;
      if (![DSGPointer]::SetCursorPos([int]$x, [int]$y)) { throw 'SetCursorPos failed'; }
      Start-Sleep -Milliseconds 16;
    }
  `,
    {
      DSG_MOUSE_X: String(point.x),
      DSG_MOUSE_Y: String(point.y),
      DSG_MOUSE_START_X: String(point.start.x),
      DSG_MOUSE_START_Y: String(point.start.y),
      DSG_MOUSE_STEPS: String(options.steps ?? 1),
    },
  );
  await page.mouse.move(x, y, options);
}

export async function launchDesktop(env) {
  const executablePath = process.env.DSG_TEST_EXECUTABLE;
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ["."],
    env,
    timeout: 45000,
  });
  try {
    app.context().setDefaultTimeout(15000);
    app.context().setDefaultNavigationTimeout(30000);
    const page = await app.firstWindow({ timeout: 15000 });
    const window = await app.browserWindow(page);
    await window.evaluate(async (window) => {
      if (!window.isVisible())
        await new Promise((resolve) => window.once("show", resolve));
    });
    if (process.platform === "win32") {
      await window.evaluate((window) => {
        window.show();
        window.focus();
      });
      await page.bringToFront();
      await page.waitForFunction(() => !document.hidden);
    }
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
