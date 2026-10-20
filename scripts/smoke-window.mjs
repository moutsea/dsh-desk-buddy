import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { powershell } from "../plugins/dsh-girl/archive.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-native-window-"));
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    petPosition: { x: 150, y: 150 },
    alwaysOnTop: true,
    idleExpressions: false,
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;

const mouseApi = `Add-Type -TypeDefinition '
using System.Runtime.InteropServices;
public class DSGInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, System.UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);
}'; `;

async function nativeClick(point, target) {
  await powershell(
    mouseApi +
      `
    [DSGInput]::SetCursorPos([int]$env:DSG_MOUSE_X, [int]$env:DSG_MOUSE_Y) | Out-Null;
    Start-Sleep -Milliseconds 150;
    [DSGInput]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero);
    Start-Sleep -Milliseconds 100;
    if ($env:DSG_MOUSE_END_X) {
      [DSGInput]::SetCursorPos([int]$env:DSG_MOUSE_END_X, [int]$env:DSG_MOUSE_END_Y) | Out-Null;
      Start-Sleep -Milliseconds 300;
    }
    [DSGInput]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero);
  `,
    {
      DSG_MOUSE_X: String(point.x),
      DSG_MOUSE_Y: String(point.y),
      DSG_MOUSE_END_X: target ? String(target.x) : "",
      DSG_MOUSE_END_Y: target ? String(target.y) : "",
    },
  );
}

async function screenshot(name) {
  await mkdir("artifacts", { recursive: true });
  await powershell(
    `
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type -AssemblyName System.Drawing;
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
    $bitmap.Save($env:DSG_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png);
    $graphics.Dispose(); $bitmap.Dispose();
  `,
    { DSG_SCREENSHOT: resolve(`artifacts/${name}.png`) },
  );
}

try {
  app = await launchDesktop(env);
  const page = await app.firstWindow({ timeout: 15000 });
  const state = () => page.evaluate(() => window.desktop.invoke("state"));
  await expect.poll(async () => (await state()).connection).toBe("connected");
  const properties = await app.evaluate(
    async ({ app, BrowserWindow, globalShortcut }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        name: app.getName(),
        title: window.getTitle(),
        windowId: window.id,
        packaged: app.isPackaged,
        resizable: window.isResizable(),
        topmost: window.isAlwaysOnTop(),
        shortcut: globalShortcut.isRegistered("CommandOrControl+Shift+Space"),
        cornerAlpha: (
          await window.webContents.capturePage({
            x: 0,
            y: 0,
            width: 2,
            height: 2,
          })
        ).toBitmap()[3],
      };
    },
  );
  if (process.env.DSG_TEST_EXECUTABLE) assert.equal(properties.packaged, true);
  assert.equal(properties.name, "dsh-desk-buddy");
  assert.equal(properties.title, "dsh-desk-buddy · 桌宠");
  assert.equal(properties.resizable, false);
  assert.equal(properties.topmost, true);
  assert.equal(properties.shortcut, true);
  assert.equal(properties.cornerAlpha, 0);
  await page.evaluate(() => window.desktop.invoke("alwaysOnTop", false));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isAlwaysOnTop(),
    ),
    false,
  );
  await page.evaluate(() => window.desktop.invoke("alwaysOnTop", true));
  if (process.platform === "win32") {
    const background = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows()[0];
      const bounds = pet.getBounds();
      const probe = new BrowserWindow({
        ...bounds,
        frame: false,
        resizable: false,
        backgroundColor: "#eeeeee",
        webPreferences: { sandbox: true },
      });
      await probe.loadURL(
        "data:text/html,<body style='margin:0;height:100vh' onclick='document.body.dataset.clicks=Number(document.body.dataset.clicks||0)+1'>Windows native mouse probe</body>",
      );
      pet.showInactive();
      probe.focus();
      return {
        id: probe.id,
        point: screen.dipToScreenPoint({ x: bounds.x + 20, y: bounds.y + 20 }),
      };
    });
    await page.evaluate(() => window.desktop.invoke("passthrough", true));
    await nativeClick(background.point);
    console.log(
      "Native click probe:",
      background,
      await app.evaluate(({ BrowserWindow, screen }) => ({
        cursor: screen.getCursorScreenPoint(),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          bounds: window.getBounds(),
          focused: window.isFocused(),
          visible: window.isVisible(),
        })),
      })),
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.fromId(id).webContents.executeJavaScript(
              "Number(document.body.dataset.clicks || 0)",
            ),
          background.id,
        ),
      )
      .toBe(1);
    await page.evaluate(() => window.desktop.invoke("section", "settings"));
    await expect(page.locator(".companion-surface")).toBeVisible();
    const content = await page.locator(".companion-surface").boundingBox();
    const contentPoint = await app.evaluate(
      ({ BrowserWindow, screen }, { content, windowId }) => {
        const bounds = BrowserWindow.fromId(windowId).getBounds();
        return screen.dipToScreenPoint({
          x: Math.round(bounds.x + content.x + 100),
          y: Math.round(bounds.y + content.y + 40),
        });
      },
      { content, windowId: properties.windowId },
    );
    await nativeClick(contentPoint);
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }, id) =>
          BrowserWindow.fromId(id).webContents.executeJavaScript(
            "Number(document.body.dataset.clicks || 0)",
          ),
        background.id,
      ),
      1,
      "the open panel receives the first click",
    );
    await page.evaluate(() => window.desktop.invoke("section", null));
    await expect(page.locator(".companion-surface")).not.toBeVisible();
    await nativeClick(contentPoint);
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.fromId(id).webContents.executeJavaScript(
              "Number(document.body.dataset.clicks || 0)",
            ),
          background.id,
        ),
      )
      .toBe(2);
    const character = page.locator(".pet-character");
    const characterPoint = async () => {
      const box = await character.boundingBox();
      return app.evaluate(
        ({ BrowserWindow, screen }, { box, windowId }) => {
          const bounds = BrowserWindow.fromId(windowId).getBounds();
          return screen.dipToScreenPoint({
            x: Math.round(bounds.x + box.x + box.width / 2),
            y: Math.round(bounds.y + box.y + box.height / 2),
          });
        },
        { box, windowId: properties.windowId },
      );
    };
    await page.evaluate(() => window.desktop.invoke("passthrough", false));
    await nativeClick(await characterPoint());
    await character.locator('[data-expression="love"]').waitFor();
    const before = await app.evaluate(
      ({ BrowserWindow }, windowId) =>
        BrowserWindow.fromId(windowId).getBounds(),
      properties.windowId,
    );
    const point = await characterPoint();
    await nativeClick(point, { x: point.x + 40, y: point.y - 25 });
    await expect
      .poll(async () => {
        const after = await app.evaluate(
          ({ BrowserWindow }, windowId) =>
            BrowserWindow.fromId(windowId).getBounds(),
          properties.windowId,
        );
        return after.x > before.x && after.y < before.y;
      })
      .toBe(true);
    await powershell(
      mouseApi +
        `
      [DSGInput]::keybd_event(17, 0, 0, [System.UIntPtr]::Zero);
      [DSGInput]::keybd_event(16, 0, 0, [System.UIntPtr]::Zero);
      [DSGInput]::keybd_event(32, 0, 0, [System.UIntPtr]::Zero);
      [DSGInput]::keybd_event(32, 0, 2, [System.UIntPtr]::Zero);
      [DSGInput]::keybd_event(16, 0, 2, [System.UIntPtr]::Zero);
      [DSGInput]::keybd_event(17, 0, 2, [System.UIntPtr]::Zero);
    `,
    );
    await expect.poll(async () => (await state()).surface.section).toBe("chat");
    await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(),
      background.id,
    );
    await screenshot("windows-native-desktop");
    console.log(
      "Windows system input passed: transparent-area and collapsed-panel click-through, character click, native drag and Ctrl+Shift+Space.",
    );
  }
  console.log(
    "Native window properties passed: packaged executable, transparency, fixed size, topmost toggle and registered shortcut.",
  );
} catch (error) {
  if (process.platform === "win32")
    await screenshot("windows-native-failure").catch(console.error);
  throw error;
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
