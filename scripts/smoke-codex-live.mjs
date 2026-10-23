// Opt-in real Codex integration. Requires a local shared App Server and login.
// Creates its own temporary workspace/thread, never selects an existing task.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexTransport } from "../shared/codex-transport.mjs";
import { CodexClient } from "../shared/codex-client.mjs";
import { sessionUsage } from "../shared/session-usage.mjs";
const endpoint = process.env.DSG_CODEX_ENDPOINT;
if (!endpoint)
  throw Error("Set DSG_CODEX_ENDPOINT to opt in to a real Codex test.");
const data = await mkdtemp(join(tmpdir(), "dsg-codex-live-"));
const owner = new CodexTransport(endpoint),
  follower = new CodexClient(endpoint);
const report = { endpoint, checks: [] };
let id, activeTurn;
async function until(fn, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await delay(100);
  }
  throw Error("Codex live test timed out");
}
const frames = [];
follower.on("frame", (f) => {
  if (f.payload.sessionId === id) frames.push(f);
});
owner.on("message", (f) => {
  if (f.params?.threadId !== id) return;
  if (f.method === "turn/started") activeTurn = f.params.turn.id;
  if (f.method === "turn/completed") activeTurn = null;
});
try {
  await owner.connect();
  ({
    thread: { id },
  } = await owner.request("thread/start", {
    cwd: data,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  }));
  report.threadId = id;
  await owner.request("turn/start", {
    threadId: id,
    input: [
      {
        type: "text",
        text: "Local integration test: reply exactly DSG_CODEX_OK. Do not use tools or change files.",
        text_elements: [],
      },
    ],
  });
  await follower.connect();
  for (let attempt = 0; attempt < 30 && !follower.attached.has(id); attempt++) {
    await follower.rpc("session.list");
    await delay(100);
  }
  assert(follower.sessions.has(id));
  report.checks.push("second client attached to same loaded thread");

  await until(() => frames.some((f) => f.payload.event?.type === "turn/end"));
  assert(frames.some((f) => f.payload.frame?.type === "chunk"));
  assert(
    frames.some((f) =>
      f.payload.event?.data?.message?.content?.some(
        (b) => b.text === "DSG_CODEX_OK",
      ),
    ),
  );
  report.usage = sessionUsage(follower.sessions.get(id).values);
  assert(report.usage.total > 0);
  report.checks.push("send, streamed reply, completion and real token usage");
  frames.length = 0;
  await owner.request("turn/start", {
    threadId: id,
    input: [
      {
        type: "text",
        text: 'Local approval/cancellation test. Run exactly this harmless command: python3 -c "import time; time.sleep(30); print(42)". Do not change files or run any other command. Request approval if required.',
        text_elements: [],
      },
    ],
  });
  await until(
    () =>
      follower.pending.size > 0 ||
      frames.some((f) => f.payload.event?.type === "tool/call") ||
      frames.some((f) => f.payload.event?.type === "turn/end"),
  );
  if (follower.pending.size) {
    const [key, request] =
      [...follower.pending].find(([, r]) => r.params.threadId === id) || [];
    assert(request, "approval must belong to the test thread");
    const command = request.params.command || "";
    const expected = 'python3 -c "import time; time.sleep(30); print(42)"';
    assert(
      [
        expected,
        `/bin/zsh -lc '${expected}'`,
        `/bin/bash -lc '${expected}'`,
      ].includes(command),
      `unexpected test command: ${command}`,
    );
    const choice = request.choices.findIndex((c) => c.decision === "accept");
    assert(choice >= 0);
    await follower.respond(key, { sessionId: id, outcome: `choice-${choice}` });
    report.checks.push("approval from one client resolved by the other");
  } else throw Error("Expected a real command approval");
  await until(() => frames.some((f) => f.payload.event?.type === "tool/call"));
  await follower.rpc("session.cancel", { sessionId: id });
  await until(() => frames.some((f) => f.payload.event?.type === "turn/end"));
  assert(
    frames.some((f) => f.payload.event?.data?.reason?.kind === "interrupted"),
  );
  report.checks.push("task started by owner cancelled by follower");
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/codex-live-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (id && activeTurn)
    await owner
      .request("turn/interrupt", { threadId: id, turnId: activeTurn })
      .catch(() => {});
  follower.close();
  owner.close();
  await rm(data, { recursive: true, force: true });
}
