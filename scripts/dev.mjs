import { spawn } from "node:child_process";
import electron from "electron";
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit" },
);
let desktop;
const stop = () => {
  desktop?.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    if ((await fetch("http://127.0.0.1:5173")).ok) {
      const env = {
        ...process.env,
        DEEPSEEK_GIRL_DEV_URL: "http://127.0.0.1:5173",
      };
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = spawn(electron, ["."], { stdio: "inherit", env });
      desktop.on("exit", (code) => {
        vite.kill();
        process.exit(code || 0);
      });
      break;
    }
  } catch {}
  if (attempt === 79) {
    stop();
    throw new Error("界面开发服务未能启动");
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
