import { _electron as electron } from "@playwright/test";

export async function launchDesktop(env) {
  const executablePath = process.env.DSG_TEST_EXECUTABLE;
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ["."],
    env,
    timeout: 45000,
  });
  app.context().setDefaultTimeout(15000);
  app.context().setDefaultNavigationTimeout(30000);
  return app;
}
