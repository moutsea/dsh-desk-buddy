import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { desktopHost } from "../tests/helpers/desktop-host.mjs";
import { desktopBridge } from "../plugins/dsh-girl/desktop-bridge.mjs";

// Exercise the actual Desktop bridge, including its authenticated gateway
// control stream, instead of injecting projection frames into the test socket.
export async function checkDesktopUsage() {
  const host = desktopHost();
  const row = host.sessions.get("s1");
  const tokenUsage = {
    uncachedInputTokens: 1000,
    cacheReadTokens: 8000,
    cacheWriteTokens: 1000,
    outputTokens: 2000,
  };
  row.projections = {
    asOfSeq: 10,
    values: {
      tokenUsage,
      contextPressure: {
        projectedTokens: 2500,
        pressureTokens: 2000,
        contextWindow: 10000,
      },
    },
  };
  row.listProjections = {
    kind: "cached",
    asOfSeq: 1000,
    values: { tokenUsage: { ...tokenUsage, outputTokens: 110000 } },
  };
  // Delay already-captured baselines independently of HTTP history replies.
  const holds = [];
  let nextHold;
  const holdBaseline = () => {
    const hold = { captured: false };
    hold.promise = new Promise((resolve) => {
      hold.release = resolve;
    });
    holds.push(hold);
    nextHold = hold;
    return hold;
  };
  const stream = host.gateway.stream.bind(host.gateway);
  host.gateway.stream = async (call) => {
    const source = await stream(call);
    if (call.method !== "control") return source;
    return (async function* () {
      for await (const frame of source) {
        if (frame.type === "baseline" && nextHold) {
          const hold = nextHold;
          nextHold = undefined;
          const captured = structuredClone(frame);
          hold.captured = true;
          await hold.promise;
          yield captured;
        } else yield frame;
      }
    })();
  };
  const initialProjections = row.projections;
  row.projections = { asOfSeq: 10, values: {} };
  const initialBaseline = holdBaseline();
  const bridge = await desktopBridge(host.ctx);
  // Playwright launches Electron with stdin closed, so the managed parent
  // lifecycle would immediately quit. This test-only local transport supplies
  // the private token normally injected by the plugin's managed launcher.
  const forward = (req) =>
    request(bridge.endpoint + req.url, {
      method: req.method,
      headers: { ...req.headers, "X-DSG-Token": bridge.token },
    });
  const proxy = createServer((req, res) => {
    const upstream = forward(req);
    upstream.on("response", (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = forward(req);
    upstream.on("upgrade", (reply, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n` +
          Object.entries(reply.headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("") +
          "\r\n",
      );
      socket.write(remoteHead);
      remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const endpoint = `http://127.0.0.1:${proxy.address().port}`;
  const data = await mkdtemp(join(tmpdir(), "dsg-desktop-usage-"));
  const env = {
    ...process.env,
    DEEPSEEK_GIRL_DATA_DIR: data,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint,
        selectedId: "s1",
        alwaysOnTop: false,
        sounds: { enabled: false },
        idleExpressions: false,
        animations: false,
      }),
    );
    app = await launchDesktop(env);
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const invoke = (action, payload) =>
      page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    await invoke("section", "chat");
    const total = page.locator('[data-metric="total"]');
    const cache = page.locator('[data-metric="cache"]');
    const context = page.locator('[data-metric="context"]');
    const baselineBarrier = async (name, seq) => {
      // This frame is queued after the held baseline, so observing it proves
      // that the renderer has processed the baseline too.
      host.publishControl({
        type: "projection",
        sessionId: "s1",
        key: "testBarrier",
        value: name,
        seq,
      });
      await expect
        .poll(
          async () =>
            (await invoke("state")).sessions.find(
              (item) => item.sessionId === "s1",
            )?.projections.values.testBarrier,
        )
        .toBe(name);
    };
    await expect.poll(() => initialBaseline.captured).toBe(true);
    await invoke("refresh");
    await expect(total).toHaveText("—");
    row.projections = initialProjections;
    await invoke("refresh");
    await expect(total).toHaveText("12.0k");
    initialBaseline.release();
    await baselineBarrier("initial", 11);
    await expect(total).toHaveText("12.0k");
    await expect(context).toHaveText("≈25.0%");
    await expect.poll(() => host.controls.size).toBe(1);
    // A reloaded projection may recalculate an existing key without a new event.
    row.projections = {
      asOfSeq: 10,
      values: {
        tokenUsage: {
          ...tokenUsage,
          cacheReadTokens: 18000,
          outputTokens: 4000,
        },
        contextPressure: {
          ...initialProjections.values.contextPressure,
          projectedTokens: 5000,
        },
      },
    };
    await invoke("refresh");
    await expect(total).toHaveText("24.0k");
    await expect(cache).toHaveText("90.0%");
    await expect(context).toHaveText("≈50.0%");
    row.projections = initialProjections;
    await invoke("refresh");
    await expect(total).toHaveText("12.0k");
    await expect(cache).toHaveText("80.0%");
    await expect(context).toHaveText("≈25.0%");
    const listsBefore = host.calls.filter(
      (call) => call.method === "list",
    ).length;
    const update = (key, value, seq) => {
      row.projections = {
        asOfSeq: Math.max(row.projections.asOfSeq, seq),
        values: { ...row.projections.values, [key]: value },
      };
      host.publishControl({
        type: "projection",
        sessionId: "s1",
        key,
        value,
        seq,
      });
    };
    update(
      "tokenUsage",
      { ...tokenUsage, cacheReadTokens: 18000, outputTokens: 4000 },
      20,
    );
    update(
      "contextPressure",
      { ...row.projections.values.contextPressure, projectedTokens: 5000 },
      15,
    );
    await expect(total).toHaveText("24.0k", { timeout: 3000 });
    await expect(cache).toHaveText("90.0%");
    await expect(context).toHaveText("≈50.0%");
    assert.equal(
      host.calls.filter((call) => call.method === "list").length,
      listsBefore,
      "live metrics must arrive without polling or a turn/end event",
    );
    await invoke("refresh");
    await expect(total).toHaveText("24.0k");

    // A fresh host generation may start with lower sequences and no capability
    // for a previously present metric. Both must replace the prior generation.
    row.projections = { asOfSeq: 1, values: { tokenUsage } };
    host.endControl();
    await expect
      .poll(() => host.calls.filter((call) => call.method === "control").length)
      .toBe(2);
    await expect(total).toHaveText("12.0k");
    await expect(context).toHaveText("—");
    update("tokenUsage", { ...tokenUsage, outputTokens: 3000 }, 2);
    await expect(total).toHaveText("13.0k");
    await invoke("refresh");
    await expect(total).toHaveText("13.0k");
    // Plugin unload/reload changes capability availability without appending an event.
    const restored = row.projections;
    row.projections = { asOfSeq: restored.asOfSeq, values: {} };
    await invoke("refresh");
    await expect(total).toHaveText("—");
    row.projections = restored;
    await invoke("refresh");
    await expect(total).toHaveText("13.0k");
    await expect(cache).toHaveText("80.0%");

    // The reverse race must not resurrect a capability removed by history.
    const reconnectBaseline = holdBaseline();
    host.endControl();
    await expect.poll(() => reconnectBaseline.captured).toBe(true);
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    row.projections = { asOfSeq: 2, values: {} };
    await invoke("refresh");
    await expect(total).toHaveText("—");
    reconnectBaseline.release();
    await baselineBarrier("reconnect", 3);
    await expect(total).toHaveText("—");
    assert.deepEqual(errors, []);
    assert.equal(
      host.calls.some((call) => call.method === "prompt"),
      false,
    );
    console.log(
      "Desktop usage passed: cached hints yield to baseline, live per-key projections reach UI without polling, reconnect resets sequences and missing metrics, same-cursor values and capabilities refresh, delayed control baselines cannot undo history in either direction. No model calls.",
    );
  } finally {
    for (const hold of holds) hold.release();
    await app?.close();
    await bridge.dispose();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(data, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
