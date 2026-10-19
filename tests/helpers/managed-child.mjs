import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const send = (value) =>
  process.stdout.write("DSG_CONTROL " + JSON.stringify(value) + "\n");
send({ type: "ready" });
send({ type: "status", connection: "connected", visible: true });
input.on("line", (line) => {
  const { action } = JSON.parse(line);
  if (action === "stop") process.exit(0);
  send({ type: "status", connection: "connected", visible: action !== "hide" });
});
input.on("close", () => process.exit(0));
