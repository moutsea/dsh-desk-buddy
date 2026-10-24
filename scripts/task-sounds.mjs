import { openSoundEvents } from "./sound-settings-dialog.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";
import { SOUND_VARIANTS } from "../shared/voices.mjs";

export async function checkTaskSounds() {
  const fixture = await createFixture();
  for (const sessionId of ["front", "back", "child"])
    fixture.sessions.set(sessionId, {
      sessionId,
      title: sessionId,
      running: false,
      blank: false,
      ...(sessionId === "child" ? { origin: "subagent" } : {}),
      updatedAt: Date.now(),
      events: [],
    });
  const data = await mkdtemp(join(tmpdir(), "dsg-task-sounds-"));
  const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        endpoint: fixture.endpoint,
        selectedId: "front",
        alwaysOnTop: false,
        petPosition: { x: 500, y: 300 },
        idleExpressions: false,
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
    await page.evaluate(() => {
      window.taskProbe = {
        starts: [],
        active: 0,
        blocked: null,
        release: null,
      };
      window.desktop.subscribe((state) => {
        window.taskProbe.pending = state.pending.length;
      });
      const bytes = new WeakMap(),
        buffers = new WeakMap();
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        constructor(options = {}) {
          super({ ...options, sampleRate: 44100 });
        }
        async decodeAudioData(data) {
          const kind = bytes.get(data);
          const buffer = await super.decodeAudioData(data);
          buffers.set(buffer, kind);
          return buffer;
        }
        createBufferSource() {
          const source = super.createBufferSource();
          const start = source.start.bind(source);
          source.start = (...args) => {
            window.taskProbe.active++;
            window.taskProbe.starts.push(buffers.get(source.buffer));
            return start(...args);
          };
          source.addEventListener("ended", () => window.taskProbe.active--);
          return source;
        }
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const kind = String(args[0]).match(/\/([^/]+)\.wav$/)?.[1];
        if (kind?.replace(/_[23]$/, "") === window.taskProbe.blocked)
          await new Promise((resolve) => {
            window.taskProbe.release = resolve;
          });
        const response = await nativeFetch(...args);
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const data = await read();
          bytes.set(data, kind);
          return data;
        };
        return response;
      };
    });
    const starts = () =>
      page.evaluate(() =>
        window.taskProbe.starts.map((kind) => kind.replace(/_[23]$/, "")),
      );
    const clips = () => page.evaluate(() => window.taskProbe.starts);
    const quiet = async (expected) => {
      await page.waitForTimeout(250);
      assert.deepEqual(await starts(), expected);
    };
    const rest = () =>
      expect.poll(() => page.evaluate(() => window.taskProbe.active)).toBe(0);
    const start = (id = "front") => {
      fixture.sessions.get(id).running = true;
      return fixture.event(id, "turn/start", {});
    };
    const end = (id = "front", kind = "cancelled") => {
      fixture.sessions.get(id).running = false;
      return fixture.event(id, "turn/end", { reason: { kind } });
    };
    const request = (rpcId, type = "question", sessionId = "back") => {
      const payload = {
        type: `${type}/requested`,
        sessionId,
        ...(type === "approval"
          ? { approvalId: rpcId, toolName: "write" }
          : {}),
        question: "继续吗？",
      };
      fixture.pending.set(rpcId, payload);
      fixture.push("mux", payload, rpcId);
    };
    const resolve = (rpcId, type = "question") => {
      fixture.pending.delete(rpcId);
      fixture.push("mux", {
        type: `${type}/resolved`,
        sessionId: "back",
        ...(type === "approval"
          ? { approvalId: rpcId }
          : { questionRpcId: rpcId }),
      });
    };

    start();
    await quiet([]);
    await invoke("refresh");
    await quiet([]);
    end();
    await invoke("section", "settings");
    const settings = await openSoundEvents(page);
    await expect(settings.getByRole("switch")).toHaveCount(13);
    const startSwitch = settings.getByRole("switch", {
      name: "开始任务声音",
      exact: true,
    });
    await expect(startSwitch).toHaveAttribute("aria-checked", "false");
    await expect(
      settings.getByRole("button", { name: "试听开始任务", exact: true }),
    ).toBeDisabled();
    await startSwitch.click();
    await expect(
      settings.getByRole("button", { name: "试听开始任务", exact: true }),
    ).toBeEnabled();
    const event = start();
    await expect.poll(starts).toEqual(["started"]);
    fixture.push("mux", { type: "session/event", sessionId: "front", event });
    await quiet(["started"]);
    end();
    await rest();
    await startSwitch.click();
    await expect(startSwitch).toHaveAttribute("aria-checked", "false");

    // Resolve a question while its first clip is still being fetched.
    await page.evaluate(() => {
      window.taskProbe.blocked = "attention";
    });
    request("resolved-during-load");
    await page.waitForFunction(
      () => typeof window.taskProbe.release === "function",
    );
    resolve("resolved-during-load");
    await expect
      .poll(async () => (await invoke("state")).pending.length)
      .toBe(0);
    await page.waitForFunction(() => window.taskProbe.pending === 0);
    await page.evaluate(() => {
      window.taskProbe.blocked = null;
      window.taskProbe.release();
    });
    await quiet(["started"]);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide(),
    );
    request("question");
    await expect.poll(starts).toEqual(["started", "attention"]);
    request("question"); // repeated frame
    await invoke("connect", fixture.endpoint); // same outstanding RPC is replayed
    await expect
      .poll(async () => (await invoke("state")).connection)
      .toBe("connected");
    await quiet(["started", "attention"]);
    resolve("question");
    await rest();
    await page.waitForTimeout(1600);
    request("approval", "approval");
    await expect.poll(starts).toEqual(["started", "attention", "attention"]);
    resolve("approval", "approval");
    await rest();
    start("back");
    const failed = end("back", "error");
    await expect
      .poll(starts)
      .toEqual(["started", "attention", "attention", "failure"]);
    fixture.push("host", {
      type: "host/agent-error",
      sessionId: "back",
      message: "Fixture failure",
    });
    fixture.push("mux", {
      type: "session/event",
      sessionId: "back",
      event: failed,
    });
    await invoke("refresh");
    await quiet(["started", "attention", "attention", "failure"]);
    await rest();
    start("back");
    fixture.push("host", {
      type: "host/agent-error",
      sessionId: "back",
      message: "Another fixture failure",
    });
    await expect
      .poll(starts)
      .toEqual(["started", "attention", "attention", "failure", "failure"]);
    // The host socket can overtake the final output on the mux socket. Wait
    // beyond playback and cooldown so a duplicate cannot hide behind either.
    await page.waitForTimeout(1600);
    await rest();
    fixture.event("back", "assistant/message", {
      message: {
        content: [{ type: "text", text: "Partial output before failure" }],
      },
    });
    await expect
      .poll(async () => (await invoke("state")).activity.back?.status)
      .toBe("replying");
    end("back", "error");
    await quiet(["started", "attention", "attention", "failure", "failure"]);
    await rest();
    start();
    fixture.event("front", "tool/result", { error: true });
    end();
    start("child");
    end("child", "error");
    request("child-question", "question", "child");
    await quiet(["started", "attention", "attention", "failure", "failure"]);
    resolve("child-question");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].show(),
    );

    const automatic = await clips();
    assert.equal(automatic[1], "attention");
    assert.notEqual(
      automatic[2],
      automatic[1],
      "new approvals vary the previous question reminder",
    );
    assert.equal(automatic[3], "failure");
    assert.notEqual(
      automatic[4],
      automatic[3],
      "a new failure varies the previous reminder",
    );

    // All new controls support explicit audition and persist independently.
    await invoke("section", "settings");
    await openSoundEvents(page);
    await startSwitch.click();
    const played = await starts();
    // Separate live turns exercise start and completion variation through the
    // real event policy, including the original per-scene cooldowns.
    for (let cycle = 0; cycle < 2; cycle++) {
      const at = Date.now();
      start();
      played.push("started");
      await expect.poll(starts).toEqual(played);
      await rest();
      end("front", "completed");
      played.push("completion");
      await expect.poll(starts).toEqual(played);
      await rest();
      if (cycle === 0)
        await page.waitForTimeout(Math.max(0, 5200 - (Date.now() - at)));
    }
    const workClips = await clips();
    for (const kind of ["started", "completion"]) {
      const selected = workClips.filter((clip) =>
        SOUND_VARIANTS[kind].includes(clip),
      );
      assert.ok(selected.length >= 2);
      for (let index = 1; index < selected.length; index++)
        assert.notEqual(selected[index], selected[index - 1]);
    }
    for (const [label, kind] of [
      ["开始任务", "started"],
      ["任务完成", "completion"],
      ["需要你回应", "attention"],
      ["任务出错", "failure"],
    ]) {
      const preview = settings.getByRole("button", {
        name: `试听${label}`,
        exact: true,
      });
      await expect(preview).toBeEnabled();
      let previous;
      for (let attempt = 0; attempt < 3; attempt++) {
        await preview.click();
        played.push(kind);
        await expect.poll(starts).toEqual(played);
        const clip = (await clips()).at(-1);
        assert.ok(SOUND_VARIANTS[kind].includes(clip));
        if (attempt === 0)
          assert.equal(clip, kind, "auditions have their own rotation");
        else
          assert.notEqual(clip, previous, "successive auditions do not repeat");
        previous = clip;
        await rest();
      }
      const toggle = settings.getByRole("switch", {
        name: `${label}声音`,
        exact: true,
      });
      await toggle.click();
      await expect(preview).toBeDisabled();
    }
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(data, "settings.json"), "utf8"))
            .sounds,
      )
      .toMatchObject({
        started: false,
        completion: false,
        attention: false,
        failure: false,
      });
    // Two new host errors can precede any turn/start (for example, retries
    // failing during setup). Sticky error state must not swallow the second.
    await invoke("soundSettings", { failure: true });
    await expect(
      settings.getByRole("button", { name: "试听任务出错", exact: true }),
    ).toBeEnabled();
    const standaloneError = (rpcId) =>
      fixture.push(
        "host",
        {
          type: "host/agent-error",
          sessionId: "back",
          message: "Setup failed before a turn could start",
        },
        rpcId,
      );
    for (const id of ["standalone-first", "standalone-second"]) {
      standaloneError(id);
      played.push("failure");
      await expect.poll(starts).toEqual(played);
      await rest();
      await page.waitForTimeout(1600);
    }
    // Retransmitting either RPC stays quiet, including one replaced by a newer cue.
    standaloneError("standalone-first");
    await quiet(played);
    standaloneError("standalone-second");
    await quiet(played);
    await invoke("soundSettings", { failure: false });
    await expect(
      settings.getByRole("button", { name: "试听任务出错", exact: true }),
    ).toBeDisabled();
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.calls.some((call) => call.path === "/api/session.prompt"),
      false,
    );
    console.log(
      "Task sounds passed: opt-in start, hidden question/approval/failure, duplicate and reconnect suppression, resolved-load cancellation, host/terminal deduplication including delayed mux output, distinct standalone host errors and old RPC retransmissions, silent cancellation/tool errors/subagents, varied live starts/completions/questions/failures, four independent rotating previews and saved switches.",
    );
  } finally {
    await app?.close();
    await fixture.close();
    await rm(data, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
