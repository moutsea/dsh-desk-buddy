import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { normalizeEndpoint } from "../shared/dsh-client.mjs";

export function managedLaunch(env = process.env) {
  if (env.DEEPSEEK_GIRL_MANAGED !== "1") return null;
  if (!env.DEEPSEEK_GIRL_DATA_DIR || !isAbsolute(env.DEEPSEEK_GIRL_DATA_DIR))
    throw new Error("插件启动缺少有效的数据目录");
  return {
    endpoint: normalizeEndpoint(env.DEEPSEEK_GIRL_ENDPOINT),
    ...(env.DEEPSEEK_GIRL_MANAGER_ENDPOINT
      ? {
          managerEndpoint: normalizeEndpoint(
            env.DEEPSEEK_GIRL_MANAGER_ENDPOINT,
          ),
        }
      : {}),
    ...(env.DEEPSEEK_GIRL_CONNECTION_TOKEN
      ? { token: env.DEEPSEEK_GIRL_CONNECTION_TOKEN }
      : {}),
  };
}
export function managedControl(app, handlers) {
  const pipe = process.env.DEEPSEEK_GIRL_CONTROL_PIPE;
  if (
    pipe &&
    (process.platform !== "win32" ||
      !/^\\\\\.\\pipe\\dsg-[a-f0-9-]{36}$/.test(pipe))
  )
    throw new Error("插件管理通道无效");
  const socket = pipe ? createConnection(pipe) : null;
  const output = socket || process.stdout;
  const input = createInterface({ input: socket || process.stdin });
  output.on("error", () => app.quit());
  socket?.on("close", () => app.quit());
  const send = (value) =>
    output.write("DSG_CONTROL " + JSON.stringify(value) + "\n");
  input.on("line", (line) => {
    if (line.length > 4096) return;
    try {
      const { action } = JSON.parse(line);
      if (Object.hasOwn(handlers, action)) handlers[action]();
    } catch {}
  });
  // The private parent pipe closes on plugin unload or a host crash.
  input.on("close", () => app.quit());
  process.on("SIGTERM", () => app.quit());
  return { send };
}
