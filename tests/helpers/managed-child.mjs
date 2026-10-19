import { createInterface } from "node:readline";
import { createConnection } from "node:net";
const socket = process.env.DEEPSEEK_GIRL_CONTROL_PIPE
  ? createConnection(process.env.DEEPSEEK_GIRL_CONTROL_PIPE)
  : null;
const input = createInterface({ input: socket || process.stdin });
const send = (value) =>
  (socket || process.stdout).write(
    "DSG_CONTROL " + JSON.stringify(value) + "\n",
  );
send({ type: "ready" });
send({ type: "status", connection: "connected", visible: true });
input.on("line", (line) => {
  const { action } = JSON.parse(line);
  if (action === "stop") process.exit(0);
  send({ type: "status", connection: "connected", visible: action !== "hide" });
});
input.on("close", () => process.exit(0));
