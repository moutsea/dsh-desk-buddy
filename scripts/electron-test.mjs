import { _electron as electron } from "@playwright/test";

export function launchDesktop(env) {
  const executablePath = process.env.DSG_TEST_EXECUTABLE;
  return electron.launch({
    executablePath,
    args: executablePath ? [] : ["."],
    env,
    timeout: 45000,
  });
}
