import { DshClient } from "../shared/dsh-client.mjs";
const client = new DshClient(process.env.DSH_URL || "http://127.0.0.1:3080");
try {
  const connected = new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("DSH 双事件连接未能就绪")),
      18000,
    );
    client.on("stream", () => {
      if (client.streams.size === 2) {
        clearTimeout(deadline);
        resolve();
      }
    });
    client.controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(deadline);
        resolve();
      },
      { once: true },
    );
  });
  const host = await client.connect();
  await connected;
  const list = await client.rpc("session.list");
  console.log(
    JSON.stringify(
      {
        connected: true,
        endpoint: client.endpoint,
        version: host.version,
        eventStreams: client.streams.size,
        sessions: list.items.length,
        cwd: host.cwd,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("连接检查失败：" + error.message);
  process.exitCode = 1;
} finally {
  client.close();
}
