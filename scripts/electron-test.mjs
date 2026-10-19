import { _electron as electron } from "@playwright/test";

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
    if (process.platform === "win32") {
      const page = await app.firstWindow({ timeout: 15000 });
      const window = await app.browserWindow(page);
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
