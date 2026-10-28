import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { CodexSession } from "../shared/codex-session.mjs";
import { AssistantStreamLinks } from "../shared/assistant-stream-links.mjs";
import { liveMessageId } from "../shared/assistant-stream.mjs";
import { mergeEvents } from "../shared/projection.mjs";
import { desktopLayout } from "../shared/desktop-layout.mjs";
import { mainActions } from "../tests/helpers/main-actions.mjs";
import { HistoryReloads } from "../electron/history-reloads.mjs";
import {
  setAssistantStream,
  setHistoryEvents,
} from "../electron/history-state.mjs";

// Exercise the built renderer with controlled IPC ordering and no native
// windows, user sessions, or real platform connections. Run after npm run build.
async function executablePath() {
  if (process.env.DSG_TEST_BROWSER) return process.env.DSG_TEST_BROWSER;
  if (process.platform === "darwin") {
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    const entries = await readdir(cache).catch(() => []);
    for (const name of entries
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const path = join(
        cache,
        name,
        `chrome-headless-shell-mac-${process.arch === "arm64" ? "arm64" : "x64"}`,
        "chrome-headless-shell",
      );
      if (existsSync(path)) return path;
    }
  }
  return chromium.executablePath();
}

const profile = await mkdtemp(join(tmpdir(), "dsg-history-browser-"));
let server, child, exited, browser;
try {
  server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
  const executable = await executablePath();
  assert.ok(!executable.includes("/Applications/Google Chrome.app/"));
  child = spawn(
    executable,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  exited = once(child, "exit").catch(() => {});
  let launchError, port;
  child.on("error", (error) => {
    launchError = error;
  });
  await expect
    .poll(
      async () => {
        if (launchError) throw launchError;
        assert.equal(child.exitCode, null, "Chromium exited before CDP");
        port = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(
            () => "",
          )
        ).split("\n")[0];
        return !!port;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  async function withPage(run) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        const listeners = new Set();
        const surfaces = new Set();
        const replies = [];
        const olderRequests = [];
        window.desktop = {
          subscribe(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
          subscribeSurface(callback) {
            surfaces.add(callback);
            return () => surfaces.delete(callback);
          },
          subscribeVisibility: () => () => {},
          invoke(action, payload) {
            if (action === "state")
              return new Promise((resolve) => replies.push(resolve));
            if (action === "visibility") return Promise.resolve(true);
            if (action === "cursorPosition")
              return Promise.resolve({ x: -100, y: -100 });
            if (action === "older")
              return new Promise((resolve, reject) =>
                olderRequests.push({ payload, resolve, reject }),
              );
            return Promise.resolve();
          },
        };
        window.historyFixture = {
          ready: () => listeners.size > 0 && replies.length > 0,
          olderRequests,
          painted: () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
          events(first, last) {
            return Array.from({ length: last - first + 1 }, (_, i) => ({
              seq: first + i,
              type: "assistant/message",
              data: {
                message: {
                  content: [{ type: "text", text: `Message ${first + i}` }],
                },
              },
            }));
          },
          state: {
            surface: {
              section: "chat",
              side: "right",
              pet: { x: 0, y: 0 },
              contentWidth: 500,
              contentHeight: 600,
              contentTop: 0,
            },
            connection: "connected",
            connectionEpoch: 1,
            connectionMessage: "",
            host: null,
            sessions: [{ sessionId: "test", title: "History", running: false }],
            selectedId: "test",
            eventsRevision: 5,
            hasMore: false,
            pending: [],
            activity: {},
            completions: [],
            balance: null,
            balanceError: "",
            config: {
              endpoint: "http://127.0.0.1:3080",
              cwd: "/tmp",
              alwaysOnTop: false,
              animations: false,
              sounds: { enabled: false },
            },
          },
          snapshot(text, revision = 5) {
            return {
              ...this.state,
              eventsRevision: revision,
              events: [
                {
                  seq: 1,
                  type: "assistant/message",
                  data: { message: { content: [{ type: "text", text }] } },
                },
              ],
            };
          },
          broadcast(value) {
            listeners.forEach((callback) => callback(structuredClone(value)));
          },
          surface(value) {
            surfaces.forEach((callback) => callback(structuredClone(value)));
          },
          reply(value) {
            replies
              .splice(0)
              .forEach((resolve) => resolve(structuredClone(value)));
          },
        };
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
      await page.waitForFunction(() => window.historyFixture.ready());
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  const viewport = (page) =>
    page.locator(".messages").evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      client: node.clientHeight,
    }));
  const messageOffset = (page, text) =>
    page
      .getByText(text, { exact: true })
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node.closest(".messages").getBoundingClientRect().top,
      );
  async function beginOlder(page) {
    await page.locator(".messages").evaluate(async (node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
      await window.historyFixture.painted();
    });
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await expect(
      page.getByRole("button", { name: "加载更早的消息" }),
    ).toBeDisabled();
    await page.waitForFunction(
      () => window.historyFixture.olderRequests.length > 0,
    );
  }
  async function showHistory(page) {
    await page.evaluate(() => {
      const fixture = window.historyFixture;
      fixture.full = {
        ...fixture.state,
        hasMore: true,
        events: fixture.events(21, 60),
      };
      fixture.reply(fixture.full);
    });
    await expect(page.getByText("Message 60", { exact: true })).toBeVisible();
    await beginOlder(page);
  }

  await test("late initial history preserves newer approvals, connection, metadata and layout", () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.broadcast({
          ...fixture.state,
          connection: "reconnecting",
          sessions: [
            { sessionId: "test", title: "Updated title", running: false },
          ],
          surface: { ...fixture.state.surface, contentWidth: 520 },
          pending: [
            {
              rpcId: "new",
              sessionId: "test",
              type: "approval/requested",
              toolName: "Latest approval",
            },
          ],
        });
      });
      await expect(
        page.getByText("Latest approval", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.reply(fixture.snapshot("Hydrated history"));
      });
      await expect(
        page.getByText("Hydrated history", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Latest approval", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".connection-strip")).toContainText(
        "重新连接中",
      );
      await expect(page.locator(".session-trigger")).toContainText(
        "Updated title",
      );
      await expect(page.locator(".companion-surface")).toHaveCSS(
        "width",
        "520px",
      );
    }));

  await test("a layout event before the initial reply keeps its newer geometry", () =>
    withPage(async (page) => {
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.surface({ ...fixture.state.surface, contentWidth: 530 });
        await fixture.painted();
        fixture.reply(fixture.snapshot("Initial history"));
      });
      await expect(
        page.getByText("Initial history", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".companion-surface")).toHaveCSS(
        "width",
        "530px",
      );
    }));

  await test("late initial history cannot hydrate a different selected session", () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.broadcast({
          ...fixture.state,
          selectedId: "other",
          sessions: [
            { sessionId: "other", title: "Other session", running: false },
          ],
        });
      });
      await expect(page.locator(".session-trigger")).toContainText(
        "Other session",
      );
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.reply(fixture.snapshot("Wrong session history"));
        await fixture.painted();
      });
      await expect(
        page.getByText("Wrong session history", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".session-trigger")).toContainText(
        "Other session",
      );
    }));

  for (const receiptFirst of [false, true])
    await test(`pages without visible messages release the request; receipt first = ${receiptFirst}`, () =>
      withPage(async (page) => {
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          fixture.full = {
            ...fixture.state,
            hasMore: true,
            events: fixture.events(41, 60).map((event) => ({
              ...event,
              type: "turn/end",
              data: { reason: { kind: "interrupted" } },
            })),
          };
          fixture.reply(fixture.full);
          await fixture.painted();
        });
        await beginOlder(page);
        await page.evaluate(async (receiptFirst) => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[0];
          if (receiptFirst) {
            request.resolve({ sessionId: "test", eventsRevision: 6 });
            await fixture.painted();
          }
          fixture.full = {
            ...fixture.full,
            events: fixture.events(21, 60).map((event) => ({
              ...event,
              type: "turn/end",
              data: { reason: { kind: "interrupted" } },
            })),
            eventsRevision: 6,
            historyPage: request.payload,
          };
          fixture.broadcast(fixture.full);
          await fixture.painted();
          if (!receiptFirst)
            request.resolve({ sessionId: "test", eventsRevision: 6 });
          await fixture.painted();
        }, receiptFirst);
        const button = page.getByRole("button", { name: "加载更早的消息" });
        await expect(button).toBeEnabled();
        await button.click();
        await page.evaluate(() => window.historyFixture.painted());
        assert.equal(
          await page.evaluate(() => window.historyFixture.olderRequests.length),
          2,
        );
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[1];
          fixture.full = {
            ...fixture.full,
            events: [...fixture.events(1, 20), ...fixture.full.events],
            eventsRevision: 7,
            historyPage: request.payload,
          };
          fixture.broadcast(fixture.full);
          request.resolve({ sessionId: "test", eventsRevision: 7 });
          await fixture.painted();
        });
        await expect(
          page.getByText("Message 1", { exact: true }),
        ).toBeVisible();
        await expect(button).toBeEnabled();
        assert.equal((await viewport(page)).top, 0);
      }));

  for (const update of ["append", "stream", "codex", "tool"])
    await test(`coalesced pagination and ${update} updates preserve the visible message`, () =>
      withPage(async (page) => {
        const codex = new CodexSession({ id: "test" });
        const turn = (n) => ({
          id: `turn-${n}`,
          status: "completed",
          items: [
            { id: `item-${n}`, type: "agentMessage", text: `Message ${n}` },
          ],
        });
        codex.mergePage(
          Array.from({ length: 40 }, (_, i) => turn(i + 21)),
          1,
        );
        const initialEvents = codex.events();
        codex.mergePage(
          Array.from({ length: 20 }, (_, i) => turn(i + 1)),
          2,
          true,
        );
        codex.updateTurn(turn(61), true);
        const nextEvents = codex.events();
        await page.evaluate(
          async ({ update, initialEvents, nextEvents }) => {
            const fixture = window.historyFixture;
            fixture.pageEvents = (first, last) =>
              fixture.events(first, last).map((event) =>
                update === "tool"
                  ? {
                      ...event,
                      type: "tool/call",
                      data: {
                        name: `Message ${event.seq}`,
                        arguments: { command: "pwd" },
                      },
                    }
                  : event,
              );
            fixture.nextEvents = nextEvents;
            fixture.full = {
              ...fixture.state,
              hasMore: true,
              events:
                update === "codex" ? initialEvents : fixture.pageEvents(21, 60),
              config: {
                ...fixture.state.config,
                provider: update === "codex" ? "codex" : "dsh",
              },
              sessions: [
                {
                  sessionId: "test",
                  title: "History",
                  running: update === "stream",
                },
              ],
              ...(update === "stream"
                ? {
                    liveAssistant: {
                      test: {
                        attemptId: "stream",
                        text: "Streaming reply",
                        revision: 1,
                      },
                    },
                  }
                : {}),
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          },
          { update, initialEvents, nextEvents },
        );
        await beginOlder(page);
        // The user can keep reading while the page is in flight.
        await page.locator(".messages").evaluate(async (node) => {
          node.scrollTop = 120;
          node.dispatchEvent(new Event("scroll"));
          await window.historyFixture.painted();
        });
        const before = await messageOffset(page, "Message 23");
        await page.evaluate(async (update) => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[0];
          fixture.full = {
            ...fixture.full,
            hasMore: false,
            events:
              update === "codex"
                ? fixture.nextEvents
                : fixture.pageEvents(1, update === "stream" ? 60 : 61),
            eventsRevision: 7,
            historyPage: request.payload,
            ...(update === "stream"
              ? {
                  liveAssistant: {
                    test: {
                      attemptId: "stream",
                      text: "Streaming reply\n\n" + "New output. ".repeat(100),
                      revision: 2,
                    },
                  },
                }
              : {}),
          };
          fixture.broadcast(fixture.full);
          request.resolve({ sessionId: "test", eventsRevision: 6 });
          await fixture.painted();
        }, update);
        const after = await messageOffset(page, "Message 23");
        assert.ok(
          Math.abs(after - before) < 1,
          `message moved from ${before}px to ${after}px`,
        );
      }));

  for (const phase of ["streaming", "completed", "hidden-completion"])
    await test(`Codex live reply identity survives pagination; phase = ${phase}`, () =>
      withPage(async (page) => {
        const row = new CodexSession({ id: "test" });
        const text = "Live heading\n\n" + "Live reply content. ".repeat(600);
        row.updateTurn({
          id: "current",
          status: "inProgress",
          items: [
            {
              id: "prompt",
              type: "userMessage",
              content: [{ type: "text", text: "Current prompt" }],
            },
            { id: "stream-item", type: "agentMessage", text },
          ],
        });
        const initialEvents = row.events("stream-item");
        row.mergePage(
          Array.from({ length: 20 }, (_, i) => ({
            id: `older-${i}`,
            status: "completed",
            items: [
              { id: `old-${i}`, type: "agentMessage", text: `Older ${i}` },
            ],
          })),
          1,
          true,
        );
        const nextEvents = row.events(
          phase === "streaming" ? "stream-item" : undefined,
        );
        await page.evaluate(
          async ({ initialEvents, text }) => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              hasMore: true,
              events: initialEvents,
              sessions: [
                { sessionId: "test", title: "Streaming", running: true },
              ],
              config: { ...fixture.state.config, provider: "codex" },
              liveAssistant: {
                test: { attemptId: "stream-item", revision: 1, text },
              },
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          },
          { initialEvents, text },
        );
        await beginOlder(page);
        await page.locator(".messages").evaluate(async (node) => {
          const live = node.querySelector(
            '[data-message-id="live-stream-item"]',
          );
          node.scrollTop =
            live.getBoundingClientRect().top -
            node.getBoundingClientRect().top +
            100;
          node.dispatchEvent(new Event("scroll"));
          await window.historyFixture.painted();
        });
        const before = await messageOffset(page, "Live heading");
        if (phase === "hidden-completion")
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
        await page.evaluate(
          async ({ nextEvents, phase }) => {
            const fixture = window.historyFixture,
              request = fixture.olderRequests[0];
            fixture.full = {
              ...fixture.full,
              events: nextEvents,
              eventsRevision: 6,
              historyPage: request.payload,
              ...(phase !== "streaming"
                ? { liveAssistant: { test: null } }
                : {}),
            };
            fixture.broadcast(fixture.full);
            request.resolve({ sessionId: "test", eventsRevision: 6 });
            await fixture.painted();
          },
          { nextEvents, phase },
        );
        if (phase === "hidden-completion")
          await page.getByRole("button", { name: "关闭会话列表" }).click();
        await page.evaluate(() => window.historyFixture.painted());
        const after = await messageOffset(page, "Live heading");
        assert.ok(
          Math.abs(after - before) < 1,
          `reply moved from ${before}px to ${after}px`,
        );
        await expect(
          page.getByText("Live heading", { exact: true }),
        ).toHaveCount(1);
      }));

  for (const delivery of ["coalesced", "separate", "hidden"])
    for (const followLatest of [true, false])
      await test(`pagination respects the latest follow choice; delivery = ${delivery}, follow = ${followLatest}`, () =>
        withPage(async (page) => {
          await showHistory(page);
          await page.locator(".messages").evaluate(async (node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          });
          if (!followLatest) {
            await page.locator(".messages").evaluate(async (node) => {
              node.scrollTop = 120;
              node.dispatchEvent(new Event("scroll"));
              await window.historyFixture.painted();
            });
          }
          const before = await messageOffset(page, "Message 23");
          if (delivery === "hidden")
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          if (delivery === "separate") {
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                events: fixture.events(21, 65),
                eventsRevision: 6,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            });
            if (followLatest) {
              const current = await viewport(page);
              assert.equal(
                current.top,
                current.height - current.client,
                "follow live output while the page is still pending",
              );
            }
          }
          await page.evaluate(async () => {
            const fixture = window.historyFixture,
              request = fixture.olderRequests[0];
            fixture.full = {
              ...fixture.full,
              events: fixture.events(1, 70),
              eventsRevision: 7,
              historyPage: request.payload,
            };
            fixture.broadcast(fixture.full);
            request.resolve({ sessionId: "test", eventsRevision: 7 });
            await fixture.painted();
          });
          if (delivery === "hidden")
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            const { events, ...status } = fixture.full;
            fixture.broadcast(status);
            await fixture.painted();
          });
          if (followLatest) {
            const after = await viewport(page);
            assert.equal(after.top, after.height - after.client);
          } else {
            assert.ok(
              Math.abs((await messageOffset(page, "Message 23")) - before) < 1,
              "scrolling up again cancels following",
            );
          }
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.full,
              events: fixture.events(1, 75),
              eventsRevision: 8,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          if (followLatest) {
            const after = await viewport(page);
            assert.equal(
              after.top,
              after.height - after.client,
              "keep following after the page commits",
            );
          } else {
            assert.ok(
              Math.abs((await messageOffset(page, "Message 23")) - before) < 1,
            );
          }
        }));

  for (const hiddenBy of ["list", "collapsed", "expressions"])
    for (const commitWhileHidden of [false, true])
      await test(`pagination retains the reader across ${hiddenBy}; hidden commit = ${commitWhileHidden}`, () =>
        withPage(async (page) => {
          await showHistory(page);
          await page.locator(".messages").evaluate(async (node) => {
            node.scrollTop = 120;
            node.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          });
          const before = await messageOffset(page, "Message 21");
          const show = async (visible) => {
            if (hiddenBy === "list") {
              await page
                .getByRole("button", {
                  name: visible ? "关闭会话列表" : "切换会话",
                  exact: true,
                })
                .click();
            } else {
              await page.evaluate(
                async ({ visible, hiddenBy }) => {
                  const fixture = window.historyFixture;
                  fixture.full = {
                    ...fixture.full,
                    surface: {
                      ...fixture.full.surface,
                      section: visible
                        ? "chat"
                        : hiddenBy === "collapsed"
                          ? null
                          : "expressions",
                    },
                  };
                  fixture.broadcast(fixture.full);
                  await fixture.painted();
                },
                { visible, hiddenBy },
              );
            }
            await page.evaluate(() => window.historyFixture.painted());
          };
          await show(false);
          await expect(page.locator(".messages")).toBeHidden();
          // Metadata updates while hidden must not replace the last visible anchor.
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            const { events, ...status } = fixture.full;
            fixture.broadcast(status);
            await fixture.painted();
          });
          if (!commitWhileHidden) await show(true);
          await page.evaluate(async () => {
            const fixture = window.historyFixture,
              request = fixture.olderRequests[0];
            fixture.full = {
              ...fixture.full,
              events: fixture.events(1, 60),
              eventsRevision: 6,
              historyPage: request.payload,
            };
            fixture.broadcast(fixture.full);
            request.resolve({ sessionId: "test", eventsRevision: 6 });
            await fixture.painted();
          });
          if (commitWhileHidden) await show(true);
          assert.ok(
            Math.abs((await messageOffset(page, "Message 21")) - before) < 1,
          );
          await expect(
            page.getByRole("button", { name: "加载更早的消息" }),
          ).toBeEnabled();
          await page.evaluate(async () => {
            const fixture = window.historyFixture,
              { events, ...status } = fixture.full;
            fixture.broadcast(status);
            await fixture.painted();
          });
          assert.ok(
            Math.abs((await messageOffset(page, "Message 21")) - before) < 1,
            "restore only once",
          );
        }));

  for (const failed of [false, true])
    for (const phase of ["visible", "hidden", "scrolled"])
      for (const receiptFirst of [false, true])
        await test(`retained reconnect history preserves older-page reading; failed = ${failed}, phase = ${phase}, receipt first = ${receiptFirst}`, () =>
          withPage(async (page) => {
            const reloads = new HistoryReloads();
            reloads.invalidate("test", 60);
            if (failed)
              reloads.finish("test", reloads.begin("test"), {
                error: "Latest history unavailable",
              });
            await page.evaluate(async (historyReload) => {
              const f = window.historyFixture;
              f.full = {
                ...f.state,
                events: f.events(21, 60),
                hasMore: true,
                historyReload,
              };
              f.reply(f.full);
              await f.painted();
            }, reloads.snapshot("test"));
            await beginOlder(page);
            const target = phase === "scrolled" ? "Message 25" : "Message 21";
            if (phase === "scrolled")
              await page
                .getByText(target, { exact: true })
                .evaluate(async (node) => {
                  const container = node.closest(".messages");
                  container.scrollTop +=
                    node.getBoundingClientRect().top -
                    container.getBoundingClientRect().top -
                    20;
                  container.dispatchEvent(new Event("scroll"));
                  await window.historyFixture.painted();
                });
            const before = await messageOffset(page, target);
            await page.evaluate(async (phase) => {
              const f = window.historyFixture;
              // Background status broadcasts and live output must not discard
              // the reader's latest anchor while the newest read is retrying.
              f.broadcast(f.full);
              await f.painted();
              f.full = {
                ...f.full,
                events: f.events(21, 61),
                eventsRevision: 6,
              };
              f.broadcast(f.full);
              await f.painted();
              if (phase === "hidden") {
                f.full = {
                  ...f.full,
                  surface: { ...f.full.surface, section: "expressions" },
                };
                f.broadcast(f.full);
                await f.painted();
              }
            }, phase);
            if (receiptFirst) {
              await page.evaluate(async () => {
                const f = window.historyFixture;
                f.olderRequests[0].resolve({
                  sessionId: "test",
                  eventsRevision: 7,
                });
                await f.painted();
              });
              if (phase !== "hidden")
                await expect(
                  page.getByRole("button", { name: "加载更早的消息" }),
                ).toBeDisabled();
            }
            await page.evaluate(async (receiptFirst) => {
              const f = window.historyFixture,
                request = f.olderRequests[0];
              f.full = {
                ...f.full,
                events: f.events(1, 61),
                eventsRevision: 7,
                historyPage: request.payload,
              };
              f.broadcast(f.full);
              if (!receiptFirst)
                request.resolve({ sessionId: "test", eventsRevision: 7 });
              await f.painted();
              if (f.full.surface.section !== "chat") {
                f.full = {
                  ...f.full,
                  surface: { ...f.full.surface, section: "chat" },
                };
                f.broadcast(f.full);
                await f.painted();
              }
            }, receiptFirst);
            assert.ok(
              Math.abs((await messageOffset(page, target)) - before) < 1,
              "older paging must keep the current message at its reading position",
            );
            await expect(
              page.getByRole("button", { name: "加载更早的消息" }),
            ).toBeEnabled();
            await page.evaluate(async () => {
              const f = window.historyFixture;
              f.full = {
                ...f.full,
                historyReload: null,
                events: f.events(1, 100),
                eventsRevision: 8,
              };
              f.broadcast(f.full);
              await f.painted();
            });
            assert.ok(
              Math.abs((await messageOffset(page, target)) - before) < 1,
              "finishing the reconnect reload must also preserve the reader's position",
            );
          }));

  await test("a history reset while unmounted discards a deferred page anchor", () =>
    withPage(async (page) => {
      await showHistory(page);
      await page.evaluate(async () => {
        const fixture = window.historyFixture,
          request = fixture.olderRequests[0];
        fixture.full = {
          ...fixture.full,
          surface: { ...fixture.full.surface, section: "expressions" },
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
        fixture.full = {
          ...fixture.full,
          events: fixture.events(1, 60),
          eventsRevision: 6,
          historyPage: request.payload,
        };
        fixture.broadcast(fixture.full);
        request.resolve({ sessionId: "test", eventsRevision: 6 });
        await fixture.painted();
        // The reset can finish before chat mounts again; do not let the old
        // page marker restore an anchor from the replaced history.
        fixture.full = {
          ...fixture.full,
          events: [],
          eventsRevision: 7,
          historyReload: { error: "" },
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
        fixture.full = {
          ...fixture.full,
          events: fixture.events(1, 60),
          eventsRevision: 8,
          historyReload: null,
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
        fixture.full = {
          ...fixture.full,
          surface: { ...fixture.full.surface, section: "chat" },
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
      });
      assert.equal((await viewport(page)).top, 0);
      await expect(
        page.getByRole("button", { name: "加载更早的消息" }),
      ).toBeEnabled();
    }));

  await test("first visible history stops following until the reader returns to the bottom", () =>
    withPage(async (page) => {
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.state,
          hasMore: true,
          events: fixture.events(41, 60).map((event) => ({
            ...event,
            type: "turn/end",
            data: { reason: { kind: "interrupted" } },
          })),
        };
        fixture.reply(fixture.full);
        await fixture.painted();
      });
      await beginOlder(page);
      await page.evaluate(async () => {
        const fixture = window.historyFixture,
          request = fixture.olderRequests[0];
        fixture.full = {
          ...fixture.full,
          events: [...fixture.events(1, 40), ...fixture.full.events],
          eventsRevision: 6,
          historyPage: request.payload,
        };
        fixture.broadcast(fixture.full);
        request.resolve({ sessionId: "test", eventsRevision: 6 });
        await fixture.painted();
        const { events, ...status } = fixture.full;
        fixture.broadcast(status);
        await fixture.painted();
      });
      assert.equal((await viewport(page)).top, 0);
      // Explicitly scrolling down resumes following new output.
      await page.locator(".messages").evaluate(async (node) => {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll"));
        await window.historyFixture.painted();
      });
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.full,
          events: [...fixture.full.events, ...fixture.events(61, 65)],
          eventsRevision: 7,
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
      });
      const after = await viewport(page);
      assert.equal(after.top, after.height - after.client);
      // A different session starts at its latest messages, even if an empty
      // snapshot arrives between selection and its history response.
      await page.locator(".messages").evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll"));
      });
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.full,
          selectedId: "other",
          sessions: [{ sessionId: "other", title: "Other", running: false }],
          events: [],
          eventsRevision: 8,
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
        fixture.full = {
          ...fixture.full,
          events: fixture.events(1, 40),
          eventsRevision: 9,
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
      });
      const switched = await viewport(page);
      assert.equal(switched.top, switched.height - switched.client);
    }));

  for (const kind of [
    "repeated-body",
    "markdown-tail",
    "interrupted-repeated-body",
  ])
    await test(`source identity preserves the original text after ${kind}`, () =>
      withPage(async (page) => {
        await page.evaluate(async (kind) => {
          const f = window.historyFixture;
          const text =
            "Reading marker\n\n" +
            Array.from(
              { length: 20 },
              (_, i) => `Paragraph ${i}. ` + "Existing text. ".repeat(20),
            ).join("\n\n") +
            (kind === "markdown-tail" ? "\n\n**Unfinished emphasis" : "");
          f.suffix = {
            seq: 21,
            type: "assistant/chunk",
            data: { turn: 21, step: 0, chunk: { type: "text-delta", text } },
          };
          f.originalText = text;
          f.remaining = [];
          if (kind === "interrupted-repeated-body") {
            const heading = "Reading marker\n\n";
            f.suffix.data.chunk.text = heading;
            f.remaining = [
              {
                seq: 22,
                type: "assistant/chunk",
                data: {
                  turn: 21,
                  step: 0,
                  chunk: {
                    type: "text-delta",
                    text: text.slice(heading.length),
                  },
                },
              },
              {
                seq: 23,
                type: "turn/end",
                data: { turn: 21, reason: { kind: "interrupted" } },
              },
            ];
          }
          f.full = {
            ...f.state,
            hasMore: true,
            events: [f.suffix, ...f.remaining, ...f.events(24, 40)],
          };
          f.reply(f.full);
          await f.painted();
        }, kind);
        await beginOlder(page);
        await page.locator(".messages").evaluate(async (node) => {
          node.scrollTop = 100;
          node.dispatchEvent(new Event("scroll"));
          await window.historyFixture.painted();
        });
        const before = await messageOffset(page, "Reading marker");
        await page.evaluate(async (kind) => {
          const f = window.historyFixture,
            req = f.olderRequests[0];
          const text =
            (kind.includes("repeated-body")
              ? f.originalText
              : "Earlier paragraph. ".repeat(300)) + "\n\n";
          const prefix = {
            seq: 20,
            type: "assistant/chunk",
            data: { turn: 21, step: 0, chunk: { type: "text-delta", text } },
          };
          const tail = {
            seq: 22,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: {
                type: "text-delta",
                text: kind === "markdown-tail" ? "**" : "",
              },
            },
          };
          f.full = {
            ...f.full,
            events: [
              ...f.events(1, 19),
              prefix,
              f.suffix,
              ...(f.remaining.length ? f.remaining : [tail]),
              ...f.events(24, 40),
            ],
            eventsRevision: 6,
            historyPage: req.payload,
          };
          f.broadcast(f.full);
          req.resolve({ sessionId: "test", eventsRevision: 6 });
          await f.painted();
        }, kind);
        const after = await page
          .getByText("Reading marker", { exact: true })
          .last()
          .evaluate(
            (node) =>
              node.getBoundingClientRect().top -
              node.closest(".messages").getBoundingClientRect().top,
          );
        assert.ok(
          Math.abs(after - before) < 1,
          "original text must stay at its previous position",
        );
      }));

  for (const phase of [
    "mux-first",
    "http-first",
    "http-before-start",
    "paging",
    "hidden-paging",
  ])
    await test(`visible HTTP finals replace cursorless streams without moving the reader; ${phase}`, () =>
      withPage(async (page) => {
        const links = new AssistantStreamLinks();
        const text = Array.from(
          { length: 60 },
          (_, i) => `Paragraph ${i}. ` + "Content to read. ".repeat(15),
        ).join("\n\n");
        const target = "Paragraph 20. " + "Content to read. ".repeat(15);
        const state = await page.evaluate(() => {
          const fixture = window.historyFixture;
          return {
            ...fixture.state,
            hasMore: true,
            events: fixture.events(21, 39),
            sessions: [
              { sessionId: "test", title: "DSH stream", running: true },
            ],
            liveAssistant: {},
          };
        });
        const step = {
          seq: 40,
          type: "step/start",
          data: { turn: 1, step: 0 },
        };
        links.observe({
          type: "session/event",
          sessionId: "test",
          event: step,
        });
        setHistoryEvents(state, [...state.events, step]);
        const raw = {
          seq: 41,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 0,
            message: { content: [{ type: "text", text }] },
          },
        };
        const start = {
          type: "start",
          attemptId: "attempt",
          revision: 1,
          turn: 1,
          step: 0,
        };
        const stream = (frame) =>
          setAssistantStream(
            state,
            "test",
            links.observe({
              type: "session/assistant-stream",
              sessionId: "test",
              frame,
            }).frame,
          );
        const snapshot = () =>
          setHistoryEvents(
            state,
            mergeEvents(state.events, links.history("test", [raw])),
          );
        const publish = () =>
          page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            await window.historyFixture.painted();
          }, state);
        const chunks = () => {
          stream(start);
          stream({
            type: "chunk",
            attemptId: "attempt",
            revision: 2,
            chunk: { type: "text-delta", text },
          });
        };
        if (phase === "http-before-start") snapshot();
        else chunks();
        await page.evaluate(async (state) => {
          window.historyFixture.reply(state);
          await window.historyFixture.painted();
        }, state);
        const paging = phase === "paging" || phase === "hidden-paging";
        if (paging) await beginOlder(page);
        await page.getByText(target, { exact: true }).evaluate(async (node) => {
          const container = node.closest(".messages");
          container.scrollTop +=
            node.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            25;
          container.dispatchEvent(new Event("scroll"));
          await window.historyFixture.painted();
        });
        const before = await messageOffset(page, target);
        if (phase === "hidden-paging")
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
        if (phase === "http-before-start") chunks();
        else if (phase !== "mux-first") snapshot();
        await publish();
        if (phase !== "hidden-paging") {
          await expect(page.getByText(target, { exact: true })).toHaveCount(1);
          assert.ok(
            Math.abs((await messageOffset(page, target)) - before) < 1,
            "the HTTP snapshot must atomically replace the live reply",
          );
        }
        if (phase !== "mux-first") {
          assert.equal(state.liveAssistant.test, null);
          // The mux can still deliver chunks/start replay and the HTTP read
          // can repeat before the final notification reaches its link cache.
          stream({
            type: "chunk",
            attemptId: "attempt",
            revision: 3,
            chunk: { type: "text-delta", text: "Late duplicate output" },
          });
          stream(start);
          snapshot();
          await publish();
          assert.equal(state.liveAssistant.test, null);
          assert.equal(state.events.at(-1).data.attemptId, "attempt");
        }
        if (paging) {
          const older = await page.evaluate(() => ({
            events: window.historyFixture.events(1, 20),
            request: window.historyFixture.olderRequests[0].payload,
          }));
          setHistoryEvents(state, mergeEvents(state.events, older.events));
          state.historyPage = older.request;
          await publish();
          await page.evaluate(async (revision) => {
            window.historyFixture.olderRequests[0].resolve({
              sessionId: "test",
              eventsRevision: revision,
            });
            await window.historyFixture.painted();
          }, state.eventsRevision);
        }
        const completed = links.observe({
          type: "session/event",
          sessionId: "test",
          event: raw,
        }).event;
        setHistoryEvents(state, mergeEvents(state.events, [completed]));
        stream({
          type: "end",
          attemptId: "attempt",
          revision: 4,
          outcome: { kind: "committed" },
        });
        await publish();
        if (phase === "hidden-paging")
          await page.getByRole("button", { name: "关闭会话列表" }).click();
        await page.evaluate(() => window.historyFixture.painted());
        await expect(page.getByText(target, { exact: true })).toHaveCount(1);
        assert.ok(
          Math.abs((await messageOffset(page, target)) - before) < 1,
          "late mux finalization and pagination must preserve the reading position",
        );
      }));

  for (const httpBeforeStart of [false, true])
    await test(`HTTP failure snapshots retire drafts before mux settlement; before start = ${httpBeforeStart}`, () =>
      withPage(async (page) => {
        const links = new AssistantStreamLinks();
        const state = await page.evaluate(() => ({
          ...window.historyFixture.state,
          events: window.historyFixture.events(21, 39),
          liveAssistant: {},
          sessions: [
            { sessionId: "test", title: "Retry settlement", running: true },
          ],
        }));
        const receive = (event) =>
          setHistoryEvents(
            state,
            mergeEvents(state.events, [
              links.observe({ type: "session/event", sessionId: "test", event })
                .event,
            ]),
          );
        receive({ seq: 40, type: "step/start", data: { turn: 1, step: 1 } });
        const stream = (frame) =>
          setAssistantStream(
            state,
            "test",
            links.observe({
              type: "session/assistant-stream",
              sessionId: "test",
              frame,
            }).frame,
          );
        const publish = () =>
          page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            await window.historyFixture.painted();
          }, state);
        const text = "Reply marker\n\n" + "Readable output. ".repeat(1000);
        const start = {
          type: "start",
          attemptId: "test:1",
          revision: 1,
          turn: 1,
          step: 1,
        };
        const draft = () => {
          stream(start);
          stream({
            type: "chunk",
            attemptId: "test:1",
            revision: 2,
            chunk: { type: "text-delta", index: 0, text },
          });
        };
        const failure = {
          seq: 41,
          type: "assistant/attempt",
          data: { turn: 1, step: 1 },
        };
        const final = {
          seq: 42,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 1,
            message: { content: [{ type: "text", text }] },
          },
        };
        const snapshot = () =>
          setHistoryEvents(
            state,
            mergeEvents(state.events, links.history("test", [failure, final])),
          );
        if (httpBeforeStart) snapshot();
        else draft();
        await page.evaluate(async (state) => {
          window.historyFixture.reply(state);
          await window.historyFixture.painted();
        }, state);
        if (httpBeforeStart) draft();
        else snapshot();
        await publish();
        assert.equal(state.liveAssistant.test, null);
        assert.equal(
          state.events.at(-1).data.attemptId,
          undefined,
          "a failed attempt must not become the successful reply's anchor",
        );
        await expect(
          page.getByText("Reply marker", { exact: true }),
        ).toHaveCount(1);

        // The failed stream can replay before its ordered mux terminal arrives.
        stream(start);
        stream({
          type: "chunk",
          attemptId: "test:1",
          revision: 3,
          chunk: { type: "text-delta", index: 0, text: "Late failed draft" },
        });
        snapshot();
        await publish();
        await expect(
          page.getByText("Late failed draft", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText("Reply marker", { exact: true }),
        ).toHaveCount(1);

        receive(failure);
        stream({
          type: "end",
          attemptId: "test:1",
          revision: 4,
          outcome: {
            kind: "committed",
            seq: 41,
            eventType: "assistant/attempt",
          },
        });
        stream({
          type: "start",
          attemptId: "test:2",
          revision: 5,
          turn: 1,
          step: 1,
        });
        stream({
          type: "chunk",
          attemptId: "test:2",
          revision: 6,
          chunk: { type: "text-delta", index: 0, text },
        });
        await publish();
        assert.equal(state.liveAssistant.test, null);
        assert.equal(state.events.at(-1).data.attemptId, "test:2");
        await expect(
          page.getByText("Reply marker", { exact: true }),
        ).toHaveCount(1);
        receive(final);
        stream({
          type: "end",
          attemptId: "test:2",
          revision: 7,
          outcome: {
            kind: "committed",
            seq: 42,
            eventType: "assistant/message",
          },
        });
        await publish();
        await expect(
          page.getByText("Reply marker", { exact: true }),
        ).toHaveCount(1);
      }));

  for (const blocks of [1, 2, 5])
    for (const hidden of [false, true])
      await test(`multiple text blocks retain the reading line through finalization and paging; blocks = ${blocks}, hidden = ${hidden}`, () =>
        withPage(async (page) => {
          const links = new AssistantStreamLinks();
          const state = await page.evaluate(() => ({
            ...window.historyFixture.state,
            events: window.historyFixture.events(21, 39),
            liveAssistant: {},
            hasMore: true,
            sessions: [
              { sessionId: "test", title: "Block offsets", running: true },
            ],
          }));
          const step = {
            seq: 40,
            type: "step/start",
            data: { turn: 1, step: 1 },
          };
          links.observe({
            type: "session/event",
            sessionId: "test",
            event: step,
          });
          setHistoryEvents(state, [...state.events, step]);
          const stream = (frame) =>
            setAssistantStream(
              state,
              "test",
              links.observe({
                type: "session/assistant-stream",
                sessionId: "test",
                frame,
              }).frame,
            );
          stream({
            type: "start",
            attemptId: "test:1",
            revision: 1,
            turn: 1,
            step: 1,
          });
          const prefix = "Heading before the main text\n\n";
          const body = "Reading paragraph. " + "Content to read. ".repeat(1500);
          const content = [...Array(blocks - 1).fill(prefix), body];
          let revision = 1;
          content.forEach((text, index) => {
            for (const chunk of [
              { type: "block-start", index, blockType: "text" },
              { type: "text-delta", index, text },
              { type: "block-end", index, block: { type: "text", text } },
            ])
              stream({
                type: "chunk",
                attemptId: "test:1",
                revision: ++revision,
                chunk,
              });
          });
          await page.evaluate(async (state) => {
            window.historyFixture.reply(state);
            await window.historyFixture.painted();
          }, state);
          await beginOlder(page);
          // Read inside a long wrapped paragraph. Paragraph-start checks miss
          // a one-character source shift that moves the visible line on commit.
          await page.getByText(body, { exact: true }).evaluate(async (node) => {
            const container = node.closest(".messages");
            container.scrollTop +=
              node.getBoundingClientRect().top -
              container.getBoundingClientRect().top +
              800;
            container.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          });
          const before = await messageOffset(page, body);
          if (hidden)
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          const final = {
            seq: 41,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 1,
              message: {
                content: content.map((text) => ({ type: "text", text })),
              },
            },
          };
          setHistoryEvents(
            state,
            mergeEvents(state.events, links.history("test", [final])),
          );
          const older = await page.evaluate(() => ({
            events: window.historyFixture.events(1, 20),
            request: window.historyFixture.olderRequests[0].payload,
          }));
          setHistoryEvents(state, mergeEvents(state.events, older.events));
          state.historyPage = older.request;
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            window.historyFixture.olderRequests[0].resolve({
              sessionId: "test",
              eventsRevision: state.eventsRevision,
            });
            await window.historyFixture.painted();
          }, state);
          if (hidden)
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          await expect(page.getByText(body, { exact: true })).toHaveCount(1);
          assert.ok(
            Math.abs((await messageOffset(page, body)) - before) < 1,
            "the same source text must stay on the same visible line",
          );
        }));

  for (const phase of ["mux-final", "http-final", "hidden-http-final"])
    await test(`reused DSH attempt IDs keep new output and pagination anchors; ${phase}`, () =>
      withPage(async (page) => {
        const links = new AssistantStreamLinks();
        const state = await page.evaluate(() => ({
          ...window.historyFixture.state,
          hasMore: true,
          events: window.historyFixture.events(21, 39),
          liveAssistant: {},
          sessions: [
            { sessionId: "test", title: "DSH lifecycle", running: true },
          ],
        }));
        const receive = (event) =>
          setHistoryEvents(
            state,
            mergeEvents(state.events, [
              links.observe({ type: "session/event", sessionId: "test", event })
                .event,
            ]),
          );
        const stream = (frame) =>
          setAssistantStream(
            state,
            "test",
            links.observe({
              type: "session/assistant-stream",
              sessionId: "test",
              frame,
            }).frame,
          );
        const publish = () =>
          page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            await window.historyFixture.painted();
          }, state);
        receive({ seq: 40, type: "step/start", data: { turn: 1, step: 1 } });
        stream({
          type: "start",
          attemptId: "test:1",
          revision: 1,
          turn: 1,
          step: 1,
        });
        const old = {
          seq: 41,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 1,
            message: {
              content: [{ type: "text", text: "Old completed reply" }],
            },
          },
        };
        receive(old);
        receive({ seq: 42, type: "turn/end", data: { turn: 1 } });
        await page.evaluate(async (state) => {
          window.historyFixture.reply(state);
          await window.historyFixture.painted();
        }, state);
        // A socket outage preserves displayed history while an Agent restart
        // resets the host's attempt counter. The subsequent HTTP read is raw.
        links.reset();
        state.liveAssistant = {};
        setHistoryEvents(
          state,
          mergeEvents(state.events, links.history("test", [old])),
        );
        receive({ seq: 43, type: "turn/start", data: { turn: 2 } });
        receive({ seq: 44, type: "step/start", data: { turn: 2, step: 2 } });
        stream({
          type: "start",
          attemptId: "test:1",
          revision: 1,
          turn: 2,
          step: 2,
        });
        const text = Array.from(
          { length: 60 },
          (_, i) => `New paragraph ${i}. ` + "Content to read. ".repeat(15),
        ).join("\n\n");
        stream({
          type: "chunk",
          attemptId: "test:1",
          revision: 2,
          chunk: { type: "text-delta", text },
        });
        await publish();
        const target = "New paragraph 20. " + "Content to read. ".repeat(15);
        await expect(page.getByText(target, { exact: true })).toHaveCount(1);
        await expect(
          page.getByText("Old completed reply", { exact: true }),
        ).toHaveCount(1);
        await beginOlder(page);
        await page.getByText(target, { exact: true }).evaluate(async (node) => {
          const container = node.closest(".messages");
          container.scrollTop +=
            node.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            25;
          container.dispatchEvent(new Event("scroll"));
          await window.historyFixture.painted();
        });
        const before = await messageOffset(page, target);
        const hidden = phase === "hidden-http-final";
        if (hidden)
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
        const final = {
          seq: 45,
          type: "assistant/message",
          data: {
            turn: 2,
            step: 2,
            message: { content: [{ type: "text", text }] },
          },
        };
        if (phase !== "mux-final") {
          setHistoryEvents(
            state,
            mergeEvents(state.events, links.history("test", [old, final])),
          );
          await publish();
          // A second raw read must retain the new reply's unique alias while
          // the pending page still holds its live anchor.
          setHistoryEvents(
            state,
            mergeEvents(state.events, links.history("test", [old, final])),
          );
        } else receive(final);
        const older = await page.evaluate(() => ({
          events: window.historyFixture.events(1, 20),
          request: window.historyFixture.olderRequests[0].payload,
        }));
        setHistoryEvents(state, mergeEvents(state.events, older.events));
        state.historyPage = older.request;
        await publish();
        await page.evaluate(async (revision) => {
          window.historyFixture.olderRequests[0].resolve({
            sessionId: "test",
            eventsRevision: revision,
          });
          await window.historyFixture.painted();
        }, state.eventsRevision);
        receive(final);
        stream({
          type: "end",
          attemptId: "test:1",
          revision: 3,
          outcome: {
            kind: "committed",
            seq: 45,
            eventType: "assistant/message",
          },
        });
        await publish();
        if (hidden)
          await page.getByRole("button", { name: "关闭会话列表" }).click();
        await page.evaluate(() => window.historyFixture.painted());
        await expect(page.getByText(target, { exact: true })).toHaveCount(1);
        assert.ok(
          Math.abs((await messageOffset(page, target)) - before) < 1,
          "the live anchor must restore the new reply, never the old reused attempt",
        );
      }));

  for (const phase of [
    "completed",
    "history-refresh",
    "end-first",
    "hidden-completion",
    "history-before-start",
  ])
    await test(`DSH cursorless reply retains its live anchor; phase = ${phase}`, () =>
      withPage(async (page) => {
        const links = new AssistantStreamLinks();
        const text = "Live heading\n\n" + "Live reply content. ".repeat(600);
        let start = { type: "start", attemptId: "dsh-attempt", revision: 1 };
        const raw = {
          seq: 41,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 0,
            message: { content: [{ type: "text", text }] },
          },
        };
        // Background history used to seed turn identity can return before
        // the mux's ordered start/chunk/final notifications are consumed.
        if (phase === "history-before-start") links.history("test", [raw]);
        start = links.observe({
          type: "session/assistant-stream",
          sessionId: "test",
          frame: start,
        }).frame;
        if (phase === "end-first")
          links.observe({
            type: "session/assistant-stream",
            sessionId: "test",
            frame: {
              type: "end",
              attemptId: start.attemptId,
              revision: 2,
              outcome: { kind: "committed" },
            },
          });
        const completed = links.observe({
          type: "session/event",
          sessionId: "test",
          event: raw,
        }).event;
        const final =
          phase === "history-refresh"
            ? links.history("test", [raw])[0]
            : completed;
        await page.evaluate(
          async ({ text, start }) => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              hasMore: true,
              events: fixture.events(21, 40),
              sessions: [
                { sessionId: "test", title: "DSH stream", running: true },
              ],
              liveAssistant: {
                test: {
                  attemptId: start.attemptId,
                  streamId: start.streamId,
                  revision: 2,
                  text,
                },
              },
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          },
          { text, start },
        );
        await beginOlder(page);
        await page.locator(".messages").evaluate(
          async (node, liveId) => {
            const live = Array.from(
              node.querySelectorAll("[data-message-id]"),
            ).find((message) => message.dataset.messageId === liveId);
            node.scrollTop +=
              live.getBoundingClientRect().top -
              node.getBoundingClientRect().top +
              100;
            node.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          },
          liveMessageId(start.attemptId, start.streamId),
        );
        const before = await messageOffset(page, "Live heading");
        if (phase === "hidden-completion")
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
        await page.evaluate(async (final) => {
          const fixture = window.historyFixture,
            request = fixture.olderRequests[0];
          fixture.full = {
            ...fixture.full,
            events: [...fixture.events(1, 40), final],
            eventsRevision: 6,
            historyPage: request.payload,
            liveAssistant: { test: null },
          };
          fixture.broadcast(fixture.full);
          request.resolve({ sessionId: "test", eventsRevision: 6 });
          await fixture.painted();
        }, final);
        if (phase === "hidden-completion")
          await page.getByRole("button", { name: "关闭会话列表" }).click();
        await page.evaluate(() => window.historyFixture.painted());
        assert.ok(
          Math.abs((await messageOffset(page, "Live heading")) - before) < 1,
        );
        await expect(
          page.getByText("Live heading", { exact: true }),
        ).toHaveCount(1);
      }));

  for (const loadedFrom of [0, 1, 2])
    for (const hidden of [false, true])
      await test(`legacy text blocks retain the reading line through backfill and finalization; loaded from = ${loadedFrom}, hidden = ${hidden}`, () =>
        withPage(async (page) => {
          const heading = "Here is the output:";
          const bodyStart = "```text\n" + "line before marker\n".repeat(35);
          const bodyEnd =
            "Reading marker\n" + "line after marker\n".repeat(80) + "```";
          const chunks = [
            { seq: 19, index: 0, text: heading },
            { seq: 20, index: 1, text: bodyStart },
            { seq: 21, index: 1, text: bodyEnd },
          ].map(({ seq, index, text }) => ({
            seq,
            type: "assistant/chunk",
            data: {
              turn: 1,
              step: 0,
              chunk: { type: "text-delta", index, text },
            },
          }));
          const state = await page.evaluate(
            (events) => ({
              ...window.historyFixture.state,
              events,
              hasMore: true,
              sessions: [
                { sessionId: "test", title: "Legacy blocks", running: true },
              ],
            }),
            chunks.slice(loadedFrom),
          );
          await page.evaluate(async (state) => {
            window.historyFixture.reply(state);
            await window.historyFixture.painted();
          }, state);
          await beginOlder(page);
          const markerTop = (scroll = false) =>
            page
              .locator(".message-content [data-source-start]")
              .evaluateAll(async (nodes, scroll) => {
                const span = nodes.find((node) =>
                  node.textContent.includes("Reading marker"),
                );
                const index = span.textContent.indexOf("Reading marker");
                const range = document.createRange();
                range.setStart(span.firstChild, index);
                range.setEnd(span.firstChild, index + 1);
                const container = span.closest(".messages");
                if (scroll) {
                  container.scrollTop +=
                    range.getBoundingClientRect().top -
                    container.getBoundingClientRect().top -
                    25;
                  container.dispatchEvent(new Event("scroll"));
                  await window.historyFixture.painted();
                }
                return (
                  range.getBoundingClientRect().top -
                  container.getBoundingClientRect().top
                );
              }, scroll);
          const before = await markerTop(true);
          if (hidden)
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          const final = {
            seq: 22,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 0,
              message: {
                content: [heading, bodyStart + bodyEnd].map((text) => ({
                  type: "text",
                  text,
                })),
              },
            },
          };
          const older = await page.evaluate(() => ({
            events: window.historyFixture.events(1, 18),
            request: window.historyFixture.olderRequests[0].payload,
          }));
          setHistoryEvents(
            state,
            mergeEvents(state.events, [...older.events, ...chunks, final]),
          );
          state.historyPage = older.request;
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            window.historyFixture.olderRequests[0].resolve({
              sessionId: "test",
              eventsRevision: state.eventsRevision,
            });
            await window.historyFixture.painted();
          }, state);
          if (hidden)
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          await expect(
            page.getByText("Reading marker", { exact: false }),
          ).toHaveCount(1);
          const after = await markerTop();
          assert.ok(
            Math.abs(after - before) < 1,
            `the same source line moved from ${before}px to ${after}px`,
          );
          await page.evaluate(async (state) => {
            const { events, ...status } = state;
            window.historyFixture.broadcast(status);
            await window.historyFixture.painted();
          }, state);
          assert.ok(
            Math.abs((await markerTop()) - before) < 1,
            "a later status update must not move the reader again",
          );
        }));

  for (const failedRead of ["session.history", "session.list"])
    await test(`first-message drafts survive a real create handler's ${failedRead} failure`, () =>
      withPage(async (page) => {
        const state = await page.evaluate(() => ({
          ...window.historyFixture.state,
          selectedId: "",
          sessions: [],
          events: [],
          liveAssistant: {},
          connections: { dsh: { status: "connected" } },
        }));
        const calls = [];
        const client = {
          connections: () => state.connections,
          async rpc(method) {
            calls.push(method);
            if (method === "session.create") return { sessionId: "created" };
            if (method === failedRead) throw new Error(`${method} unavailable`);
            if (method === "session.list")
              return {
                items: [
                  { sessionId: "created", title: "Created", running: false },
                ],
              };
            if (method === "session.history")
              return { events: [], hasMore: false };
            if (method === "session.prompt") throw new Error("Prompt failed");
            throw new Error(`Unexpected RPC ${method}`);
          },
        };
        const actions = mainActions({ client, state });
        await page.exposeFunction(
          "mainCreateAction",
          async (action, payload) => {
            try {
              return await actions.invoke(action, payload);
            } finally {
              await page.evaluate(async (snapshot) => {
                window.historyFixture.broadcast(snapshot);
                await window.historyFixture.painted();
              }, structuredClone(state));
            }
          },
        );
        await page.evaluate(async (initial) => {
          const original = window.desktop.invoke;
          window.desktop.invoke = (action, payload) =>
            ["create", "send"].includes(action)
              ? window.mainCreateAction(action, payload)
              : original(action, payload);
          window.historyFixture.reply(initial);
          await window.historyFixture.painted();
        }, structuredClone(state));
        const input = page.getByRole("textbox", { name: "消息", exact: true });
        await input.fill("  First draft after a confirmed creation  ");
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
        await expect(page.getByText(/Prompt failed/)).toBeVisible();
        await expect(input).toHaveValue(
          "  First draft after a confirmed creation  ",
        );
        await expect(input).toBeEnabled();
        assert.equal(state.selectedId, "created");
        assert.equal(
          calls.filter((method) => method === "session.create").length,
          1,
        );
        assert.equal(
          calls.filter((method) => method === "session.prompt").length,
          1,
        );
        if (failedRead === "session.history")
          await expect(
            page.getByText("会话历史加载失败，正在重试…", { exact: true }),
          ).toBeVisible();
      }));

  for (const phase of [
    "removed-before-ack",
    "coalesced-removal",
    "removed-after-ack",
    "removed-after-error",
    "superseded",
  ])
    for (const automatic of [true, false])
      await test(`obsolete creation receipts release the composer; phase = ${phase}, automatic = ${automatic}`, () =>
        withPage(async (page) => {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              selectedId: "",
              sessions: [
                { sessionId: "other", title: "Other session", running: false },
              ],
              events: [],
            };
            fixture.sends = [];
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create")
                return new Promise((resolve) => {
                  fixture.creation = { payload, resolve };
                });
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.sends.push({ payload, resolve, reject });
                });
              if (action === "select") {
                fixture.full = {
                  ...fixture.full,
                  selectedId: payload,
                  eventsRevision: fixture.full.eventsRevision + 1,
                };
                fixture.broadcast(fixture.full);
                return Promise.resolve(payload);
              }
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          });
          const input = page.getByRole("textbox", {
            name: "消息",
            exact: true,
          });
          if (automatic) {
            await input.fill("  Keep this draft  ");
            await page
              .getByRole("button", { name: "发送消息", exact: true })
              .click();
          } else
            await page
              .getByRole("button", { name: "新建会话", exact: true })
              .click();
          await page.waitForFunction(() => !!window.historyFixture.creation);
          if (["removed-after-ack", "removed-after-error"].includes(phase)) {
            await page.evaluate(() =>
              window.historyFixture.creation.resolve("created"),
            );
            if (automatic)
              await page.waitForFunction(
                () => window.historyFixture.sends.length === 1,
              );
            await page.evaluate(() => window.historyFixture.painted());
            await expect(input).toBeDisabled();
            if (automatic && phase === "removed-after-error")
              await page.evaluate(async () => {
                window.historyFixture.sends[0].reject(
                  new Error("Prompt unavailable"),
                );
                await window.historyFixture.painted();
              });
          }
          await page.evaluate(async (phase) => {
            const fixture = window.historyFixture;
            const sessionCreation = {
              sessionId: "created",
              requestId: fixture.creation.payload.requestId,
            };
            if (phase === "removed-before-ack" || phase === "superseded") {
              fixture.full = {
                ...fixture.full,
                sessionCreation,
                selectedId: "created",
                sessions: [
                  ...fixture.full.sessions,
                  { sessionId: "created", title: "Created", running: false },
                ],
                eventsRevision: 6,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            }
            fixture.full = {
              ...fixture.full,
              sessionCreation,
              eventsRevision: 7,
              selectedId: phase === "superseded" ? "other" : "",
              sessions:
                phase === "superseded"
                  ? fixture.full.sessions
                  : fixture.full.sessions.filter(
                      (row) => row.sessionId !== "created",
                    ),
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
            if (!["removed-after-ack", "removed-after-error"].includes(phase))
              fixture.creation.resolve("created");
            await fixture.painted();
          }, phase);
          if (
            automatic &&
            ["removed-after-ack", "superseded"].includes(phase)
          ) {
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 1,
            );
            await page.evaluate(async () => {
              window.historyFixture.sends[0].reject(
                new Error("Prompt unavailable"),
              );
              await window.historyFixture.painted();
            });
          }
          await expect(input).toBeEnabled();
          if (automatic && phase !== "superseded")
            await expect(input).toHaveValue("  Keep this draft  ");
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
          await page
            .locator(".session-card")
            .filter({ hasText: "Other session" })
            .click();
          await expect(input).toBeEnabled();
          await input.fill("Continue the other chat");
          await page
            .getByRole("button", { name: "发送消息", exact: true })
            .click();
          await page.waitForFunction(
            () =>
              window.historyFixture.sends.at(-1)?.payload.sessionId === "other",
          );
          await page.evaluate(async () => {
            window.historyFixture.sends.at(-1).resolve("");
            await window.historyFixture.painted();
          });
          await expect(input).toHaveValue("");
        }));

  for (const scenario of [
    ...["before-ack", "after-ack"].flatMap((order) =>
      ["created", "removed", "sent", "send-failed", "existing"].map(
        (outcome) => ({ provider: "dsh", order, outcome }),
      ),
    ),
    { provider: "dsh", order: "before-ack", outcome: "creation-failed" },
    ...["before-ack", "after-ack"].map((order) => ({
      provider: "codex",
      order,
      outcome: "created",
    })),
  ])
    await test(`manual creation preserves only the unbound platform draft; ${JSON.stringify(scenario)}`, () =>
      withPage(async (page) => {
        const { provider, order, outcome } = scenario;
        const id = provider === "codex" ? "codex:created" : "created";
        await page.evaluate(
          async ({ provider, outcome }) => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              config: { ...fixture.state.config, provider },
              connections: {
                dsh: { status: "offline" },
                codex: { status: "offline" },
                [provider]: { status: "connected" },
              },
              selectedId: outcome === "existing" ? "other" : "",
              sessions: [
                {
                  sessionId: "other",
                  provider,
                  title: "Original session",
                  running: false,
                },
              ],
              events: [],
            };
            fixture.creates = 0;
            fixture.sends = [];
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create") {
                fixture.creates++;
                return new Promise((resolve, reject) => {
                  fixture.creation = { payload, resolve, reject };
                });
              }
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.sends.push({ payload, resolve, reject });
                });
              if (action === "select") {
                fixture.full = {
                  ...fixture.full,
                  selectedId: payload,
                  eventsRevision: fixture.full.eventsRevision + 1,
                };
                fixture.broadcast(fixture.full);
                return Promise.resolve(payload);
              }
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          },
          { provider, outcome },
        );
        const input = page.getByRole("textbox", { name: "消息", exact: true });
        const raw = "  Draft before manual creation\n  ";
        await input.fill(raw);
        await page
          .getByRole("button", { name: "新建会话", exact: true })
          .click();
        await page.waitForFunction(() => !!window.historyFixture.creation);
        assert.equal(
          await page.evaluate(
            () => window.historyFixture.creation.payload.provider,
          ),
          provider,
        );
        const publish = (removed = false) =>
          page.evaluate(
            async ({ id, provider, removed }) => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId: removed ? "" : id,
                sessions: removed
                  ? fixture.full.sessions.filter((row) => row.sessionId !== id)
                  : [
                      ...fixture.full.sessions.filter(
                        (row) => row.sessionId !== id,
                      ),
                      {
                        sessionId: id,
                        provider,
                        title: "Created",
                        running: false,
                      },
                    ],
                sessionCreation: {
                  requestId: fixture.creation.payload.requestId,
                  sessionId: id,
                },
                eventsRevision: fixture.full.eventsRevision + 1,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            },
            { id, provider, removed },
          );
        if (outcome === "creation-failed") {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.creation.reject(new Error("Manual creation failed"));
            await fixture.painted();
          });
          await expect(input).toBeEnabled();
          await expect(input).toHaveValue(raw);
        } else {
          if (order === "before-ack") await publish();
          await page.evaluate(async (id) => {
            const fixture = window.historyFixture;
            fixture.creation.resolve(id);
            await fixture.painted();
          }, id);
          if (order === "after-ack") {
            await expect(input).toBeDisabled();
            await publish(outcome === "removed");
          }
          await expect(input).toBeEnabled();
          await expect(input).toHaveValue(outcome === "existing" ? "" : raw);
          assert.equal(
            await page.evaluate(() => window.historyFixture.sends.length),
            0,
            "manual creation must not submit the draft",
          );
          if (outcome === "removed") {
            if (order === "before-ack") await publish(true);
            await expect(input).toHaveValue(raw);
          } else if (outcome === "sent" || outcome === "send-failed") {
            await page
              .getByRole("button", { name: "发送消息", exact: true })
              .click();
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 1,
            );
            assert.deepEqual(
              await page.evaluate(() => window.historyFixture.sends[0].payload),
              { sessionId: id, text: raw.trim() },
            );
            await publish(true);
            await page.evaluate(async (outcome) => {
              const fixture = window.historyFixture;
              if (outcome === "sent") fixture.sends[0].resolve("");
              else
                fixture.sends[0].reject(new Error("Manual draft send failed"));
              await fixture.painted();
            }, outcome);
            await expect(input).toHaveValue(outcome === "sent" ? "" : raw);
          } else if (outcome === "existing") {
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
            await page
              .locator(".session-card")
              .filter({ hasText: "Original session" })
              .click();
            await expect(input).toHaveValue(raw);
          } else {
            // The unbound slot was transferred, rather than copied.
            await page
              .getByRole("button", { name: "发送消息", exact: true })
              .click();
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 1,
            );
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.sends[0].resolve("");
              await fixture.painted();
            });
            await publish(true);
            await expect(input).toHaveValue("");
          }
        }
        await expect(input).toBeEnabled();
        assert.equal(
          await page.evaluate(() => window.historyFixture.creates),
          1,
        );
      }));

  for (const provider of ["dsh", "codex"])
    for (const initialReady of [false, true])
      for (const restored of initialReady
        ? [false, true]
        : [false, true, "removed"])
        await test(`creation drafts retain their session through connection reset; provider = ${provider}, initial list = ${initialReady}, restored = ${restored}`, () =>
          withPage(async (page) => {
            const id = provider === "codex" ? "codex:created" : "created";
            await page.evaluate(
              async ({ provider, id, initialReady }) => {
                const f = window.historyFixture;
                f.full = {
                  ...f.state,
                  config: { ...f.state.config, provider },
                  sessions: [],
                  selectedId: "",
                  events: [],
                  connections: {
                    dsh: { status: "offline", epoch: 0, sessionsReady: false },
                    codex: {
                      status: "offline",
                      epoch: 0,
                      sessionsReady: false,
                    },
                    [provider]: {
                      status: "connected",
                      epoch: 1,
                      sessionsReady: initialReady,
                    },
                  },
                };
                f.sends = 0;
                const original = window.desktop.invoke;
                window.desktop.invoke = async (action, payload) => {
                  if (action === "create") {
                    f.full = {
                      ...f.full,
                      selectedId: id,
                      sessions: [
                        {
                          sessionId: id,
                          provider,
                          title: "Created",
                          running: false,
                        },
                      ],
                      sessionCreation: {
                        requestId: payload.requestId,
                        sessionId: id,
                      },
                      eventsRevision: f.full.eventsRevision + 1,
                    };
                    f.broadcast(f.full);
                    await f.painted();
                    return id;
                  }
                  if (action === "send") f.sends++;
                  return original(action, payload);
                };
                f.reply(f.full);
                await f.painted();
              },
              { provider, id, initialReady },
            );
            const input = page.getByRole("textbox", {
              name: "消息",
              exact: true,
            });
            await input.fill("Draft before creation");
            await page
              .getByRole("button", { name: "新建会话", exact: true })
              .click();
            await expect(input).toBeEnabled();
            await expect(input).toHaveValue("Draft before creation");
            const draft = "Edited draft in the created session";
            await input.fill(draft);
            const publish = ({
              status,
              epoch,
              sessionsReady,
              selected = false,
            }) =>
              page.evaluate(
                async ({
                  provider,
                  id,
                  status,
                  epoch,
                  sessionsReady,
                  selected,
                }) => {
                  const f = window.historyFixture;
                  f.full = {
                    ...f.full,
                    selectedId: selected ? id : "",
                    sessions: selected
                      ? [
                          {
                            sessionId: id,
                            provider,
                            title: "Created",
                            running: false,
                          },
                        ]
                      : [],
                    events: [],
                    eventsRevision: f.full.eventsRevision + 1,
                    connections: {
                      ...f.full.connections,
                      [provider]: { status, epoch, sessionsReady },
                    },
                  };
                  f.broadcast(f.full);
                  await f.painted();
                },
                { provider, id, status, epoch, sessionsReady, selected },
              );
            if (restored === "removed") {
              await publish({
                status: "connected",
                epoch: 1,
                sessionsReady: false,
              });
              await expect(input).toHaveValue(draft);
              await publish({
                status: "connected",
                epoch: 1,
                sessionsReady: false,
              });
              await expect(input).toHaveValue(draft);
              return;
            }
            await publish({
              status: "offline",
              epoch: 2,
              sessionsReady: false,
            });
            await expect(input).toHaveValue("");
            const unbound = "Independent unbound draft";
            await input.fill(unbound);
            await publish({
              status: "connected",
              epoch: 3,
              sessionsReady: false,
            });
            await expect(input).toHaveValue(unbound);
            // Failed initial refreshes still return an empty cache. A status
            // broadcast or another platform's list is not proof of deletion.
            await publish({
              status: "connected",
              epoch: 3,
              sessionsReady: false,
            });
            await expect(input).toHaveValue(unbound);
            await publish({
              status: "connected",
              epoch: 3,
              sessionsReady: true,
              selected: restored,
            });
            await expect(input).toHaveValue(
              restored ? draft : `${unbound}\n\n${draft}`,
            );
            if (restored) {
              await publish({
                status: "connected",
                epoch: 3,
                sessionsReady: true,
              });
              await expect(input).toHaveValue(`${unbound}\n\n${draft}`);
            }
            await publish({
              status: "connected",
              epoch: 3,
              sessionsReady: true,
            });
            await expect(input).toHaveValue(`${unbound}\n\n${draft}`);
            assert.equal(
              await page.evaluate(() => window.historyFixture.sends),
              0,
            );
          }));

  for (const identical of [false, true])
    for (const outcome of ["create-failure", "send-failure", "success"])
      await test(`recovery during another creation preserves both drafts; identical = ${identical}, outcome = ${outcome}`, () =>
        withPage(async (page) => {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              selectedId: "",
              sessions: [
                { sessionId: "other", title: "Other session", running: false },
              ],
              events: [],
            };
            fixture.creations = [];
            fixture.sends = [];
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create")
                return new Promise((resolve, reject) => {
                  fixture.creations.push({ payload, resolve, reject });
                });
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.sends.push({ payload, resolve, reject });
                });
              if (action === "select") {
                fixture.full = {
                  ...fixture.full,
                  selectedId: payload,
                  eventsRevision: fixture.full.eventsRevision + 1,
                };
                fixture.broadcast(fixture.full);
                return Promise.resolve(payload);
              }
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          });
          const input = page.getByRole("textbox", {
            name: "消息",
            exact: true,
          });
          const send = page.getByRole("button", {
            name: "发送消息",
            exact: true,
          });
          const nextDraft = "  Draft for the next session\n  ";
          const recovered = identical ? nextDraft : "  Recovered old draft\n  ";
          const confirm = (index, sessionId) =>
            page.evaluate(
              async ({ index, sessionId }) => {
                const fixture = window.historyFixture;
                fixture.full = {
                  ...fixture.full,
                  selectedId: sessionId,
                  sessions: [
                    ...fixture.full.sessions,
                    { sessionId, running: false },
                  ],
                  sessionCreation: {
                    requestId: fixture.creations[index].payload.requestId,
                    sessionId,
                  },
                  eventsRevision: fixture.full.eventsRevision + 1,
                };
                fixture.broadcast(fixture.full);
                await fixture.painted();
                fixture.creations[index].resolve(sessionId);
              },
              { index, sessionId },
            );
          const remove = (sessionId) =>
            page.evaluate(async (sessionId) => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId:
                  fixture.full.selectedId === sessionId
                    ? ""
                    : fixture.full.selectedId,
                sessions: fixture.full.sessions.filter(
                  (row) => row.sessionId !== sessionId,
                ),
                eventsRevision: fixture.full.eventsRevision + 1,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            }, sessionId);
          await input.fill(recovered);
          await send.click();
          await page.waitForFunction(
            () => window.historyFixture.creations.length === 1,
          );
          await confirm(0, "created-a");
          await page.waitForFunction(
            () => window.historyFixture.sends.length === 1,
          );
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.sends[0].reject(new Error("First send failed"));
            await fixture.painted();
          });
          await expect(input).toHaveValue(recovered);
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
          await page
            .locator(".session-card")
            .filter({ hasText: "Other session" })
            .click();
          await expect(input).toBeVisible();
          await remove("other");
          await input.fill(nextDraft);
          await send.click();
          await page.waitForFunction(
            () => window.historyFixture.creations.length === 2,
          );
          await remove("created-a");
          await expect(input).toHaveValue(`${nextDraft}\n\n${recovered}`);
          if (outcome === "create-failure") {
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.creations[1].reject(new Error("Creation failed"));
              await fixture.painted();
            });
          } else {
            await confirm(1, "created-b");
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 2,
            );
            assert.equal(
              await page.evaluate(
                () => window.historyFixture.sends[1].payload.text,
              ),
              nextDraft.trim(),
              "a recovered draft must not be sent without a new submission",
            );
            await page.evaluate(async (outcome) => {
              const fixture = window.historyFixture;
              if (outcome === "success") fixture.sends[1].resolve("");
              else fixture.sends[1].reject(new Error("Next send failed"));
              await fixture.painted();
            }, outcome);
            await expect(input).toHaveValue(
              outcome === "success" ? "" : nextDraft,
            );
            await remove("created-b");
          }
          const expected =
            outcome === "create-failure"
              ? `${nextDraft}\n\n${recovered}`
              : outcome === "send-failure"
                ? `${recovered}\n\n${nextDraft}`
                : recovered;
          await expect(input).toBeEnabled();
          await expect(input).toHaveValue(expected);
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          await expect(input).toHaveValue(expected);
          assert.deepEqual(
            await page.evaluate(() => ({
              creates: window.historyFixture.creations.length,
              sends: window.historyFixture.sends.length,
            })),
            { creates: 2, sends: outcome === "create-failure" ? 1 : 2 },
          );
        }));

  for (const automatic of [false, true])
    for (const failure of [false, true])
      await test(`suggestions cannot overwrite a pending send; automatic = ${automatic}, failure = ${failure}`, () =>
        withPage(async (page) => {
          await page.evaluate(async (automatic) => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              ...(automatic ? { selectedId: "", sessions: [] } : {}),
              events: [],
            };
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create")
                return new Promise((resolve) => {
                  fixture.creation = { payload, resolve };
                });
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.send = { payload, resolve, reject };
                });
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          }, automatic);
          const input = page.getByRole("textbox", {
            name: "消息",
            exact: true,
          });
          const suggestion = page.getByRole("button", {
            name: "先看看这个项目",
            exact: true,
          });
          const raw = "  Original draft\n  ";
          await input.fill(raw);
          await page
            .getByRole("button", { name: "发送消息", exact: true })
            .click();
          await expect(input).toBeDisabled();
          await expect(suggestion).toBeDisabled();
          await suggestion.click({ force: true });
          await expect(input).toHaveValue(raw);
          if (automatic) {
            await page.waitForFunction(() => !!window.historyFixture.creation);
            await page.evaluate(() =>
              window.historyFixture.creation.resolve("created"),
            );
          }
          await page.waitForFunction(() => !!window.historyFixture.send);
          assert.equal(
            await page.evaluate(() => window.historyFixture.send.payload.text),
            raw.trim(),
          );
          await expect(suggestion).toBeDisabled();
          await suggestion.click({ force: true });
          await page.evaluate(async (failure) => {
            const fixture = window.historyFixture;
            if (failure) fixture.send.reject(new Error("Send failed"));
            else fixture.send.resolve("");
            await fixture.painted();
          }, failure);
          await expect(input).toHaveValue(failure ? raw : "");
          if (automatic) {
            // The RPC has settled, but its selection broadcast is still pending.
            await expect(input).toBeDisabled();
            await expect(suggestion).toBeDisabled();
            await suggestion.click({ force: true });
            await expect(input).toHaveValue(failure ? raw : "");
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId: "created",
                sessions: [{ sessionId: "created", running: false }],
                sessionCreation: {
                  requestId: fixture.creation.payload.requestId,
                  sessionId: "created",
                },
                eventsRevision: fixture.full.eventsRevision + 1,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            });
          }
          await expect(input).toBeEnabled();
          await expect(suggestion).toBeEnabled();
          await suggestion.click();
          await expect(input).toHaveValue("先看看这个项目");
        }));

  await test("suggestions share the composer's read-only restriction", () =>
    withPage(async (page) => {
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.reply({
          ...fixture.state,
          events: [],
          sessions: [{ ...fixture.state.sessions[0], readOnly: true }],
        });
        await fixture.painted();
      });
      const input = page.getByRole("textbox", { name: "消息", exact: true });
      const suggestion = page.getByRole("button", {
        name: "先看看这个项目",
        exact: true,
      });
      await expect(input).toBeDisabled();
      await expect(suggestion).toBeDisabled();
      await suggestion.click({ force: true });
      await expect(input).toHaveValue("");
    }));

  for (const confirmation of ["before-ack", "after-ack"])
    for (const outcome of [
      "failure",
      "edited-failure",
      "superseded",
      "retry-success",
      "retry-failure",
      "success",
    ])
      await test(`confirmed creation retains draft recovery after selection; confirmation = ${confirmation}, outcome = ${outcome}`, () =>
        withPage(async (page) => {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              selectedId: "",
              sessions: [],
              events: [],
            };
            fixture.sends = [];
            fixture.creates = 0;
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create") {
                fixture.creates++;
                return new Promise((resolve) => {
                  fixture.creation = { payload, resolve };
                });
              }
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.sends.push({ payload, resolve, reject });
                });
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          });
          const input = page.getByRole("textbox", {
            name: "消息",
            exact: true,
          });
          const send = page.getByRole("button", {
            name: "发送消息",
            exact: true,
          });
          const raw = "  Preserve my first draft\n  ";
          const edited = "  Revised draft after the failure\n  ";
          await input.fill(raw);
          await send.click();
          await page.waitForFunction(() => !!window.historyFixture.creation);
          const confirm = () =>
            page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId: "created",
                sessions: [{ sessionId: "created", running: false }],
                sessionCreation: {
                  requestId: fixture.creation.payload.requestId,
                  sessionId: "created",
                },
                eventsRevision: 6,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            });
          if (confirmation === "before-ack") await confirm();
          await page.evaluate(() =>
            window.historyFixture.creation.resolve("created"),
          );
          await page.waitForFunction(
            () => window.historyFixture.sends.length === 1,
          );
          if (confirmation === "after-ack") await confirm();
          // Let the confirmed selection release its waiting state before the
          // send settles. Recovery must survive independently of that state.
          await page.evaluate(() => window.historyFixture.painted());
          await page.evaluate(async (outcome) => {
            const fixture = window.historyFixture;
            if (outcome === "success") fixture.sends[0].resolve("");
            else fixture.sends[0].reject(new Error("First send failed"));
            await fixture.painted();
          }, outcome);
          await expect(input).toBeEnabled();
          await expect(input).toHaveValue(outcome === "success" ? "" : raw);
          if (outcome === "edited-failure") await input.fill(edited);
          if (outcome === "superseded") {
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId: "other",
                sessions: [
                  ...fixture.full.sessions,
                  { sessionId: "other", running: false },
                ],
                sessionCreation: {
                  requestId: "another-creation",
                  sessionId: "other",
                },
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            });
            await input.fill("Draft belonging to the other session");
          }
          if (outcome.startsWith("retry-")) {
            await send.click();
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 2,
            );
          }
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.full,
              selectedId: fixture.full.selectedId === "other" ? "other" : "",
              sessions: fixture.full.sessions.filter(
                (row) => row.sessionId !== "created",
              ),
              eventsRevision: 7,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          if (outcome.startsWith("retry-")) {
            await expect(input).toBeDisabled();
            await page.evaluate(async (outcome) => {
              const fixture = window.historyFixture;
              if (outcome === "retry-success") fixture.sends[1].resolve("");
              else fixture.sends[1].reject(new Error("Retry failed"));
              await fixture.painted();
            }, outcome);
          }
          await expect(input).toBeEnabled();
          if (outcome === "superseded") {
            await expect(input).toHaveValue(
              "Draft belonging to the other session",
            );
            await page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.full,
                selectedId: "",
                sessions: [],
                eventsRevision: 8,
              };
              fixture.broadcast(fixture.full);
              await fixture.painted();
            });
          }
          const expected = outcome.endsWith("success")
            ? ""
            : outcome === "edited-failure"
              ? edited
              : raw;
          await expect(input).toHaveValue(expected);
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          await expect(input).toHaveValue(expected);
          assert.equal(
            await page.evaluate(() => window.historyFixture.creates),
            1,
            "draft recovery must not create another session or retry a write",
          );
          assert.equal(
            await page.evaluate(() => window.historyFixture.sends.length),
            outcome.startsWith("retry-") ? 2 : 1,
          );
        }));

  for (const order of [
    "before-create-ack",
    "before-send-ack",
    "after-send-ack",
  ])
    for (const failure of [false, true])
      await test(`first send transfers its draft to the created session; selection = ${order}, failure = ${failure}`, () =>
        withPage(async (page) => {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              selectedId: "",
              sessions: [],
              events: [],
            };
            fixture.created = {
              ...fixture.full,
              selectedId: "created",
              sessions: [
                { sessionId: "created", title: "Created", running: false },
              ],
              eventsRevision: 6,
            };
            fixture.creates = 0;
            fixture.sends = [];
            const original = window.desktop.invoke;
            window.desktop.invoke = (action, payload) => {
              if (action === "create") {
                fixture.creates += 1;
                return new Promise((resolve, reject) => {
                  fixture.createRequest = { resolve, reject };
                });
              }
              if (action === "send")
                return new Promise((resolve, reject) => {
                  fixture.sends.push({ payload, resolve, reject });
                });
              return original(action, payload);
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          });
          const input = page.getByRole("textbox", {
            name: "消息",
            exact: true,
          });
          const raw = "  Keep my first draft\n  ";
          await input.fill(raw);
          await page
            .getByRole("button", { name: "发送消息", exact: true })
            .click();
          await page.waitForFunction(
            () => !!window.historyFixture.createRequest,
          );
          const selectCreated = () =>
            page.evaluate(async () => {
              const fixture = window.historyFixture;
              fixture.broadcast(fixture.created);
              await fixture.painted();
            });
          if (order === "before-create-ack") await selectCreated();
          await page.evaluate(() =>
            window.historyFixture.createRequest.resolve("created"),
          );
          await page.waitForFunction(
            () => window.historyFixture.sends.length === 1,
          );
          assert.deepEqual(
            await page.evaluate(() => window.historyFixture.sends[0].payload),
            { sessionId: "created", text: raw.trim() },
          );
          if (order === "before-send-ack") await selectCreated();
          await page.evaluate(async (failure) => {
            const request = window.historyFixture.sends[0];
            if (failure) request.reject(new Error("Prompt request failed"));
            else request.resolve("");
            await window.historyFixture.painted();
          }, failure);
          await expect(input).toHaveValue(failure ? raw : "");
          if (order === "after-send-ack") {
            await expect(input).toBeDisabled();
            await selectCreated();
          }
          await expect(input).toBeEnabled();
          await expect(input).toHaveValue(failure ? raw : "");
          if (failure) {
            await expect(page.getByText(/Prompt request failed/)).toBeVisible();
            await page
              .getByRole("button", { name: "发送消息", exact: true })
              .click();
            await page.waitForFunction(
              () => window.historyFixture.sends.length === 2,
            );
            assert.equal(
              await page.evaluate(() => window.historyFixture.creates),
              1,
            );
            assert.equal(
              await page.evaluate(
                () => window.historyFixture.sends[1].payload.sessionId,
              ),
              "created",
            );
            await page.evaluate(async () => {
              window.historyFixture.sends[1].resolve("");
              await window.historyFixture.painted();
            });
            await expect(input).toHaveValue("");
          }
          // The original "new" slot must not resurrect a sent draft later.
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.broadcast({ ...fixture.full, eventsRevision: 7 });
            await fixture.painted();
          });
          await expect(input).toHaveValue("");
        }));

  await test("failed automatic creation leaves the original draft available", () =>
    withPage(async (page) => {
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        const original = window.desktop.invoke;
        window.desktop.invoke = (action, payload) =>
          action === "create"
            ? Promise.reject(new Error("Creation failed"))
            : original(action, payload);
        fixture.reply({
          ...fixture.state,
          selectedId: "",
          sessions: [],
          events: [],
        });
        await fixture.painted();
      });
      const input = page.getByRole("textbox", { name: "消息", exact: true });
      await input.fill("  Original draft  ");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByText(/Creation failed/)).toBeVisible();
      await expect(input).toHaveValue("  Original draft  ");
      await expect(input).toBeEnabled();
    }));

  for (const dimension of ["width", "height"])
    for (const following of [true, false])
      for (const hidden of [false, true])
        await test(`surface resizing preserves the reader's follow choice; dimension = ${dimension}, follow = ${following}, hidden = ${hidden}`, () =>
          withPage(async (page) => {
            const area = { x: 0, y: 0, width: 1280, height: 900 };
            const before = desktopLayout(
              { x: 0, y: 300 },
              area,
              "chat",
              100,
              "large",
            ).surface;
            const after = desktopLayout(
              { x: dimension === "width" ? 490 : 0, y: 300 },
              { ...area, height: dimension === "height" ? 600 : area.height },
              "chat",
              100,
              "large",
            ).surface;
            await page.evaluate(async (surface) => {
              const fixture = window.historyFixture;
              fixture.full = {
                ...fixture.state,
                surface,
                events: fixture.events(1, 40).map((event) => ({
                  ...event,
                  data: {
                    message: {
                      content: [
                        {
                          type: "text",
                          text:
                            "Long prose in the conversation to test wrapping. ".repeat(
                              12,
                            ) +
                            `\n\nReading marker ${event.seq}\n\n` +
                            "More prose after the marker. ".repeat(12),
                        },
                      ],
                    },
                  },
                })),
              };
              fixture.reply(fixture.full);
              await fixture.painted();
            }, before);
            const marker = "Reading marker 20";
            const readEarlier = () =>
              page.getByText(marker, { exact: true }).evaluate(async (node) => {
                const container = node.closest(".messages");
                container.scrollTop +=
                  node.getBoundingClientRect().top -
                  container.getBoundingClientRect().top +
                  3;
                container.dispatchEvent(new Event("scroll"));
                await window.historyFixture.painted();
              });
            if (!following) await readEarlier();
            const markerBefore = await messageOffset(page, marker);
            const checkPosition = async () => {
              if (following) {
                const position = await viewport(page);
                assert.equal(position.top, position.height - position.client);
              } else
                assert.ok(
                  Math.abs((await messageOffset(page, marker)) - markerBefore) <
                    1,
                );
            };
            if (hidden)
              await page
                .getByRole("button", { name: "切换会话", exact: true })
                .click();
            for (const surface of [after, before, after]) {
              await page.evaluate(async (surface) => {
                const fixture = window.historyFixture;
                fixture.full = { ...fixture.full, surface };
                fixture.surface(surface);
                await fixture.painted();
              }, surface);
              if (!hidden) await checkPosition();
            }
            if (hidden)
              await page.getByRole("button", { name: "关闭会话列表" }).click();
            await page.evaluate(() => window.historyFixture.painted());
            await checkPosition();
            const append = () =>
              page.evaluate(async () => {
                const fixture = window.historyFixture;
                const seq = fixture.full.events.at(-1).seq + 1;
                fixture.full = {
                  ...fixture.full,
                  events: [...fixture.full.events, ...fixture.events(seq, seq)],
                  eventsRevision: fixture.full.eventsRevision + 1,
                };
                fixture.broadcast(fixture.full);
                await fixture.painted();
              });
            await append();
            await checkPosition();
            // Genuine scrolling still changes follow after a layout correction.
            if (following) {
              await readEarlier();
              const offset = await messageOffset(page, marker);
              await append();
              assert.ok(
                Math.abs((await messageOffset(page, marker)) - offset) < 1,
              );
            } else {
              await page.locator(".messages").evaluate(async (node) => {
                node.scrollTop = node.scrollHeight;
                node.dispatchEvent(new Event("scroll"));
                await window.historyFixture.painted();
              });
              await append();
              const position = await viewport(page);
              assert.equal(position.top, position.height - position.client);
            }
          }));

  await test("resizing short history to its bottom does not enable following", () =>
    withPage(async (page) => {
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.state,
          surface: { ...fixture.state.surface, contentHeight: 460 },
          events: fixture.events(1, 8),
        };
        fixture.reply(fixture.full);
        await fixture.painted();
      });
      await page.locator(".messages").evaluate(async (node) => {
        node.scrollTop = 150;
        node.dispatchEvent(new Event("scroll"));
        await window.historyFixture.painted();
      });
      const before = await viewport(page);
      assert.ok(before.height - before.client - before.top > 75);
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.full,
          surface: { ...fixture.full.surface, contentHeight: 760 },
        };
        fixture.surface(fixture.full.surface);
        await fixture.painted();
      });
      const resized = await viewport(page);
      assert.equal(resized.top, resized.height - resized.client);
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.full,
          events: fixture.events(1, 16),
          eventsRevision: 6,
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
      });
      assert.equal((await viewport(page)).top, resized.top);
    }));

  for (const order of [
    "ack-only",
    "history-before-ack",
    "ack-before-history",
    "hidden-ack",
    "rejected",
    "other-session",
  ])
    await test(`sending restores follow only for a successful current-session receipt; order = ${order}`, () =>
      withPage(async (page) => {
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          fixture.full = { ...fixture.state, events: fixture.events(1, 60) };
          fixture.engagePending = 0;
          const original = window.desktop.invoke;
          window.desktop.invoke = (action, payload) => {
            if (action === "engage") {
              fixture.engagePending += 1;
              setTimeout(() => {
                const { events, ...status } = fixture.full;
                fixture.broadcast(status);
                fixture.engagePending -= 1;
              }, 35);
              return Promise.resolve();
            }
            if (action === "send")
              return new Promise((resolve, reject) => {
                fixture.sendRequest = { payload, resolve, reject };
              });
            return original(action, payload);
          };
          fixture.reply(fixture.full);
          await fixture.painted();
        });
        const readEarlier = () =>
          page.locator(".messages").evaluate(async (node) => {
            node.scrollTop = 400;
            node.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          });
        const submit = async (text) => {
          await page.evaluate(() => {
            window.historyFixture.sendRequest = null;
          });
          await page
            .getByRole("textbox", { name: "消息", exact: true })
            .fill(text);
          await page
            .getByRole("button", { name: "发送消息", exact: true })
            .click();
          // Let the incidental engagement broadcast finish before the receipt;
          // it must not stand in for a later history update.
          await page.waitForFunction(() => {
            const fixture = window.historyFixture;
            return fixture.sendRequest && fixture.engagePending === 0;
          });
          await page.evaluate(() => window.historyFixture.painted());
        };
        const publish = () =>
          page.evaluate(async () => {
            const fixture = window.historyFixture;
            const seq = fixture.full.events.at(-1).seq + 1;
            fixture.full = {
              ...fixture.full,
              events: [...fixture.full.events, ...fixture.events(seq, seq)],
              eventsRevision: fixture.full.eventsRevision + 1,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
        const acknowledge = () =>
          page.evaluate(async () => {
            window.historyFixture.sendRequest.resolve("");
            await window.historyFixture.painted();
          });
        const expectBottom = async () => {
          const position = await viewport(page);
          assert.equal(position.top, position.height - position.client);
        };
        await readEarlier();
        await submit("Test input");
        if (order === "history-before-ack") {
          await publish();
          assert.equal((await viewport(page)).top, 400);
        }
        if (order === "other-session") {
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.full,
              selectedId: "other",
              sessions: [
                { sessionId: "other", title: "Other", running: false },
              ],
              events: fixture.events(1, 60),
              eventsRevision: fixture.full.eventsRevision + 1,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          await readEarlier();
        }
        if (order === "hidden-ack")
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
        if (order === "rejected") {
          await page.evaluate(async () => {
            window.historyFixture.sendRequest.reject(new Error("Send failed"));
            await window.historyFixture.painted();
          });
          await expect(
            page.getByRole("textbox", { name: "消息", exact: true }),
          ).toHaveValue("Test input");
          await expect(page.getByText(/Send failed/)).toBeVisible();
        } else {
          await acknowledge();
          await expect(
            page.getByRole("textbox", {
              name: "消息",
              exact: true,
              includeHidden: true,
            }),
          ).toHaveValue("");
        }
        if (order === "hidden-ack")
          await page.getByRole("button", { name: "关闭会话列表" }).click();
        await page.evaluate(() => window.historyFixture.painted());
        if (order === "rejected" || order === "other-session") {
          assert.equal((await viewport(page)).top, 400);
          await publish();
          assert.equal((await viewport(page)).top, 400);
          return;
        }
        // Check immediately, including ack-before-history: a successful send
        // must not need another broadcast to get the reader to the bottom.
        await expectBottom();
        if (order !== "ack-only") {
          await publish();
          await expectBottom();
        } else {
          // Every successful send must trigger the effect, not just the first.
          await readEarlier();
          await submit("Second input");
          await acknowledge();
          await expectBottom();
        }
        await readEarlier();
        await publish();
        assert.equal((await viewport(page)).top, 400);
      }));

  for (const phase of [
    "together",
    "final-first",
    "hidden-final-first",
    "no-page",
    "hidden-no-page",
  ])
    for (const followLatest of [false, true])
      await test(`prefix finals preserve independent reading anchors; phase = ${phase}, follow = ${followLatest}`, () =>
        withPage(async (page) => {
          const paging = !phase.endsWith("no-page");
          const hidden = phase.startsWith("hidden-");
          const prefixText =
            "Earlier body\n\n" + "Prefix paragraph\n\n".repeat(35);
          const body =
            "Before marker\n\n".repeat(20) +
            "Reading marker\n\n" +
            "After marker\n\n".repeat(50);
          const chunk = (seq, text) => ({
            seq,
            type: "assistant/chunk",
            data: {
              turn: 1,
              step: 0,
              chunk: { type: "text-delta", index: 0, text },
            },
          });
          const earlier = chunk(19, prefixText),
            tail = chunk(20, body);
          const final = {
            seq: 21,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 0,
              message: { content: [{ type: "text", text: prefixText + body }] },
            },
          };
          const state = await page.evaluate(
            (events) => ({
              ...window.historyFixture.state,
              events,
              hasMore: true,
              sessions: [
                { sessionId: "test", title: "Early final", running: true },
              ],
            }),
            [tail],
          );
          await page.evaluate(async (state) => {
            window.historyFixture.reply(state);
            await window.historyFixture.painted();
          }, state);
          if (paging) await beginOlder(page);
          const markerTop = (scroll = false) =>
            page
              .getByText("Reading marker", { exact: true })
              .evaluate(async (node, scroll) => {
                const container = node.closest(".messages");
                if (scroll) {
                  container.scrollTop +=
                    node.getBoundingClientRect().top -
                    container.getBoundingClientRect().top +
                    3;
                  container.dispatchEvent(new Event("scroll"));
                  await window.historyFixture.painted();
                }
                return (
                  node.getBoundingClientRect().top -
                  container.getBoundingClientRect().top
                );
              }, scroll);
          const before = await markerTop(true);
          if (followLatest)
            await page.locator(".messages").evaluate(async (node) => {
              node.scrollTop = node.scrollHeight;
              node.dispatchEvent(new Event("scroll"));
              await window.historyFixture.painted();
            });
          const assertPosition = async (stage) => {
            if (followLatest) {
              const view = await viewport(page);
              assert.equal(
                view.top,
                view.height - view.client,
                `${stage}: keep following the latest output`,
              );
            } else {
              const after = await markerTop();
              assert.ok(
                Math.abs(after - before) < 1,
                `${stage}: reading line moved from ${before}px to ${after}px`,
              );
            }
          };
          if (hidden)
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          if (phase !== "together") {
            // No page receipt yet: the final alone supplies the missing prefix.
            setHistoryEvents(state, mergeEvents(state.events, [final]), true);
            await page.evaluate(async (state) => {
              window.historyFixture.broadcast(state);
              await window.historyFixture.painted();
            }, state);
            if (hidden)
              await page.getByRole("button", { name: "关闭会话列表" }).click();
            await page.evaluate(() => window.historyFixture.painted());
            await assertPosition("before the older page arrives");
          }
          if (paging) {
            const older = await page.evaluate(() => ({
              events: window.historyFixture.events(1, 18),
              request: window.historyFixture.olderRequests[0].payload,
            }));
            setHistoryEvents(
              state,
              mergeEvents(state.events, [...older.events, earlier, final]),
              false,
            );
            state.historyPage = older.request;
            await page.evaluate(async (state) => {
              window.historyFixture.broadcast(state);
              window.historyFixture.olderRequests[0].resolve({
                sessionId: "test",
                eventsRevision: state.eventsRevision,
              });
              await window.historyFixture.painted();
            }, state);
          }
          await assertPosition("after finalization and pagination");
          await page.evaluate(async (state) => {
            const { events, ...status } = state;
            window.historyFixture.broadcast(status);
            await window.historyFixture.painted();
          }, state);
          await assertPosition("after a status-only update");
          const extra = await page.evaluate(() =>
            window.historyFixture.events(22, 24),
          );
          setHistoryEvents(state, mergeEvents(state.events, extra));
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            await window.historyFixture.painted();
          }, state);
          await assertPosition("after later output");
        }));

  for (const fullHistory of [true, false])
    await test(
      "closed block must retain its own occurrence; full history = " +
        fullHistory,
      () =>
        withPage(async (page) => {
          const body =
            "First block body\n\n" +
            "Before marker\n\n".repeat(20) +
            "Reading marker\n\n" +
            "After marker\n\n".repeat(35);
          const duplicate = "Second block header\n\n" + body;
          const chunk = (seq, index, type, text) => ({
            seq,
            type: "assistant/chunk",
            data: {
              turn: 1,
              step: 0,
              chunk:
                type === "block-end"
                  ? { type, index, block: { type: "text", text } }
                  : { type, index, text },
            },
          });
          const chunks = [
            chunk(19, 0, "text-delta", body),
            chunk(20, 1, "text-delta", duplicate),
            chunk(21, 1, "block-end", duplicate),
            chunk(22, 0, "block-end", body),
          ];
          const state = await page.evaluate(
            (events) => ({
              ...window.historyFixture.state,
              events,
              hasMore: true,
              sessions: [
                {
                  sessionId: "test",
                  title: "Repeated block suffix",
                  running: true,
                },
              ],
            }),
            fullHistory ? chunks : chunks.slice(-1),
          );
          await page.evaluate(async (state) => {
            window.historyFixture.reply(state);
            await window.historyFixture.painted();
          }, state);
          await beginOlder(page);
          const markerTop = (occurrence = 0, scroll = false) =>
            page
              .getByText("Reading marker", { exact: true })
              .nth(occurrence)
              .evaluate(async (node, scroll) => {
                const container = node.closest(".messages");
                if (scroll) {
                  container.scrollTop +=
                    node.getBoundingClientRect().top -
                    container.getBoundingClientRect().top +
                    3;
                  container.dispatchEvent(new Event("scroll"));
                  await window.historyFixture.painted();
                }
                return (
                  node.getBoundingClientRect().top -
                  container.getBoundingClientRect().top
                );
              }, scroll);
          const before = await markerTop(0, true);
          await page
            .getByRole("button", { name: "切换会话", exact: true })
            .click();
          const final = {
            seq: 23,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 0,
              message: {
                content: [body, duplicate].map((text) => ({
                  type: "text",
                  text,
                })),
              },
            },
          };
          // A final arrives before the outstanding older-page response. On return
          // to the chat, the suspended request restores its last visible anchor.
          setHistoryEvents(state, mergeEvents(state.events, [final]), true);
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            await window.historyFixture.painted();
          }, state);
          await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          const after = await markerTop();
          assert.ok(
            Math.abs(after - before) < 1,
            "must keep the first block, not jump to the duplicate in another block",
          );
          // The delayed page then supplies the other block. The durable final ID
          // must keep the current occurrence through this second update as well.
          const older = await page.evaluate(() => ({
            events: window.historyFixture.events(1, 18),
            request: window.historyFixture.olderRequests[0].payload,
          }));
          setHistoryEvents(
            state,
            mergeEvents(state.events, [...older.events, ...chunks]),
            false,
          );
          state.historyPage = older.request;
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            window.historyFixture.olderRequests[0].resolve({
              sessionId: "test",
              eventsRevision: state.eventsRevision,
            });
            await window.historyFixture.painted();
          }, state);
          assert.ok(
            Math.abs((await markerTop()) - before) < 1,
            "late prefix backfill must keep the same occurrence",
          );
        }),
    );
  for (const rewritten of [false, true])
    for (const interrupted of [false, true])
      for (const hidden of [false, true])
        await test(`capture a corrected block's current text anchor; rewritten = ${rewritten}, interrupted = ${interrupted}, hidden = ${hidden}`, () =>
          withPage(async (page) => {
            const prefixText =
              "Earlier block\n\n" + "Older paragraph\n\n".repeat(35);
            const body =
              "Before marker\n\n".repeat(20) +
              "Reading marker\n\n" +
              "After marker\n\n".repeat(40);
            const chunk = (seq, index, type, text) => ({
              seq,
              type: "assistant/chunk",
              data: {
                turn: 1,
                step: 0,
                chunk:
                  type === "block-end"
                    ? { type, index, block: { type: "text", text } }
                    : { type, index, text },
              },
            });
            const chunks = [
              chunk(19, 0, "text-delta", prefixText),
              chunk(20, 0, "block-end", prefixText),
              chunk(
                21,
                1,
                "text-delta",
                rewritten ? "Draft placeholder" : body,
              ),
              chunk(22, 1, "block-end", body),
            ];
            const terminal = interrupted
              ? [
                  {
                    seq: 23,
                    type: "turn/end",
                    data: { turn: 1, reason: { kind: "aborted" } },
                  },
                ]
              : [];
            const state = await page.evaluate(
              (events) => ({
                ...window.historyFixture.state,
                events,
                hasMore: true,
                sessions: [
                  {
                    sessionId: "test",
                    title: "Corrected block",
                    running: true,
                  },
                ],
              }),
              [...chunks.slice(2), ...terminal],
            );
            state.sessions[0].running = !interrupted;
            await page.evaluate(async (state) => {
              window.historyFixture.reply(state);
              await window.historyFixture.painted();
            }, state);
            await beginOlder(page);
            const markerTop = (scroll = false) =>
              page
                .getByText("Reading marker", { exact: true })
                .evaluate(async (node, scroll) => {
                  const container = node.closest(".messages");
                  if (scroll) {
                    container.scrollTop +=
                      node.getBoundingClientRect().top -
                      container.getBoundingClientRect().top +
                      3;
                    container.dispatchEvent(new Event("scroll"));
                    await window.historyFixture.painted();
                  }
                  return (
                    node.getBoundingClientRect().top -
                    container.getBoundingClientRect().top
                  );
                }, scroll);
            const before = await markerTop(true);
            if (hidden)
              await page
                .getByRole("button", { name: "切换会话", exact: true })
                .click();
            setHistoryEvents(state, mergeEvents(state.events, chunks), true);
            state.historyPage = await page.evaluate(
              () => window.historyFixture.olderRequests[0].payload,
            );
            await page.evaluate(async (state) => {
              window.historyFixture.broadcast(state);
              window.historyFixture.olderRequests[0].resolve({
                sessionId: "test",
                eventsRevision: state.eventsRevision,
              });
              await window.historyFixture.painted();
            }, state);
            if (hidden)
              await page.getByRole("button", { name: "关闭会话列表" }).click();
            await page.evaluate(() => window.historyFixture.painted());
            const after = await markerTop();
            assert.ok(
              Math.abs(after - before) < 1,
              `corrected reading line moved from ${before}px to ${after}px`,
            );
            await page.evaluate(async (state) => {
              const { events, ...status } = state;
              window.historyFixture.broadcast(status);
              await window.historyFixture.painted();
            }, state);
            assert.ok(
              Math.abs((await markerTop()) - before) < 1,
              "status-only updates must preserve the corrected line",
            );
          }));

  for (const fullPrefix of [true, false])
    for (const hidden of [false, true])
      await test(`interleaved blocks retain their reading line when finalized from a partial page; full prefix = ${fullPrefix}, hidden = ${hidden}`, () =>
        withPage(async (page) => {
          const first =
            "First block:\n\n" + "Earlier first-block line\n\n".repeat(35);
          const firstTail = "End of first block\n\n";
          const second = "Second block:\n\n" + "Before marker\n\n".repeat(30);
          const secondTail =
            "Reading marker\n\n" + "After marker\n\n".repeat(80);
          const chunks = [
            { seq: 19, index: 0, text: first },
            { seq: 20, index: 1, text: second },
            { seq: 21, index: 0, text: firstTail },
            { seq: 22, index: 1, text: secondTail },
          ].map(({ seq, index, text }) => ({
            seq,
            type: "assistant/chunk",
            data: {
              turn: 1,
              step: 0,
              chunk: { type: "text-delta", index, text },
            },
          }));
          const state = await page.evaluate(
            (events) => ({
              ...window.historyFixture.state,
              events,
              hasMore: true,
              sessions: [
                { sessionId: "test", title: "Interleaved", running: true },
              ],
            }),
            chunks.slice(2),
          );
          await page.evaluate(async (state) => {
            window.historyFixture.reply(state);
            await window.historyFixture.painted();
          }, state);
          await beginOlder(page);
          const markerTop = (scroll = false) =>
            page
              .getByText("Reading marker", { exact: true })
              .evaluate(async (node, scroll) => {
                const container = node.closest(".messages");
                if (scroll) {
                  // Make this paragraph the first visible text, so the anchor
                  // cannot belong to the preceding, independently growing block.
                  container.scrollTop +=
                    node.getBoundingClientRect().top -
                    container.getBoundingClientRect().top +
                    3;
                  container.dispatchEvent(new Event("scroll"));
                  await window.historyFixture.painted();
                }
                return (
                  node.getBoundingClientRect().top -
                  container.getBoundingClientRect().top
                );
              }, scroll);
          const before = await markerTop(true);
          if (hidden)
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          const final = {
            seq: 23,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 0,
              message: {
                content: [first + firstTail, second + secondTail].map(
                  (text) => ({ type: "text", text }),
                ),
              },
            },
          };
          // The older page may contain only seq 20: the first block's opening
          // remains unloaded, and the observed block order becomes [1, 0].
          setHistoryEvents(
            state,
            mergeEvents(state.events, [
              ...chunks.slice(fullPrefix ? 0 : 1),
              final,
            ]),
            true,
          );
          state.historyPage = await page.evaluate(
            () => window.historyFixture.olderRequests[0].payload,
          );
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            window.historyFixture.olderRequests[0].resolve({
              sessionId: "test",
              eventsRevision: state.eventsRevision,
            });
            await window.historyFixture.painted();
          }, state);
          if (hidden)
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          const after = await markerTop();
          assert.ok(
            Math.abs(after - before) < 1,
            `the same source line moved from ${before}px to ${after}px`,
          );
          await expect(
            page.getByText("Reading marker", { exact: true }),
          ).toHaveCount(1);

          // A subsequent page can finally supply every block start. The final
          // message's canonical identity and reading location must stay stable.
          await beginOlder(page);
          const beforeNextPage = await markerTop(true);
          const older = await page.evaluate(() => ({
            events: window.historyFixture.events(1, 18),
            request: window.historyFixture.olderRequests[1].payload,
          }));
          setHistoryEvents(
            state,
            mergeEvents(state.events, [...older.events, ...chunks]),
            false,
          );
          state.historyPage = older.request;
          await page.evaluate(async (state) => {
            window.historyFixture.broadcast(state);
            window.historyFixture.olderRequests[1].resolve({
              sessionId: "test",
              eventsRevision: state.eventsRevision,
            });
            await window.historyFixture.painted();
          }, state);
          assert.ok(
            Math.abs((await markerTop()) - beforeNextPage) < 1,
            "later prefix backfill must retain the final message's reading location",
          );
          await page.evaluate(async (state) => {
            const { events, ...status } = state;
            window.historyFixture.broadcast(status);
            await window.historyFixture.painted();
          }, state);
          assert.ok(
            Math.abs((await markerTop()) - beforeNextPage) < 1,
            "a status update must not move the reader again",
          );
        }));

  for (const format of [
    "code",
    "entities",
    "inline",
    "table",
    "quote",
    "quoted-code",
  ])
    await test(`source anchors preserve ${format} text across a streamed prefix`, () =>
      withPage(async (page) => {
        const bodies = {
          code:
            "```text\nReading marker\n" + "line of code\n".repeat(60) + "```",
          entities:
            "Escaped \\*symbols\\* &amp; &#x1F600;\n\nReading marker\n\n" +
            "Body. ".repeat(500),
          inline:
            "`Reading marker`\n\n" +
            "Body with **bold** and `code`. ".repeat(200),
          table:
            "| Column | Value |\n| --- | --- |\n| Reading marker | test |\n" +
            "| row | value |\n".repeat(40),
          quote: "> Reading marker\n> " + "Quoted content.\n> ".repeat(60),
          "quoted-code":
            "> ```text\n> Reading marker\n" +
            "> line of code\n".repeat(60) +
            "> ```",
        };
        await page.evaluate(async (text) => {
          const fixture = window.historyFixture;
          fixture.suffix = {
            seq: 21,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: { type: "text-delta", text },
            },
          };
          fixture.full = {
            ...fixture.state,
            hasMore: true,
            events: [fixture.suffix, ...fixture.events(23, 40)],
          };
          fixture.reply(fixture.full);
          await fixture.painted();
        }, bodies[format]);
        await beginOlder(page);
        // A source span can contain an entire code block; measure its first
        // line through a Range rather than requiring a standalone text node.
        const markerTop = () =>
          page
            .locator(".message-content [data-source-start]")
            .evaluateAll((nodes) => {
              const span = nodes.find((node) =>
                node.textContent.includes("Reading marker"),
              );
              const index = span.textContent.indexOf("Reading marker");
              const range = document.createRange();
              range.setStart(span.firstChild, index);
              range.setEnd(span.firstChild, index + 1);
              return (
                range.getBoundingClientRect().top -
                span.closest(".messages").getBoundingClientRect().top
              );
            });
        const before = await markerTop();
        await page.evaluate(async () => {
          const fixture = window.historyFixture,
            request = fixture.olderRequests[0];
          const prefix = {
            seq: 20,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: {
                type: "text-delta",
                text: "Earlier paragraph. ".repeat(100) + "\n\n",
              },
            },
          };
          fixture.full = {
            ...fixture.full,
            events: [
              ...fixture.events(1, 19),
              prefix,
              fixture.suffix,
              ...fixture.events(23, 40),
            ],
            eventsRevision: 6,
            historyPage: request.payload,
          };
          fixture.broadcast(fixture.full);
          request.resolve({ sessionId: "test", eventsRevision: 6 });
          await fixture.painted();
        });
        assert.ok(
          Math.abs((await markerTop()) - before) < 1,
          `${format}: keep the same source character in view`,
        );
      }));

  for (const [kind, heading, prefix, code, suffix = ""] of [
    ["nested lists", "- Outer\n  - Inner\n", "    > ", false],
    ["indented lists", "  - Outer\n    - Inner\n", "        > ", false],
    ["ordered lists", "1. Outer\n   1. Inner\n", "      > ", false],
    ["lists in a quote", "> - Outer\n>   - Inner\n", ">     > ", false],
    ["tab indentation", "- Outer\n  - Inner\n", "\t> ", false],
    ["quoted code", "- Outer\n  - Inner\n", "    > ", true],
    ["varying quote indentation", "   > Outer\n> - List\n", ">     > ", false],
    [
      "code in varying quote indentation",
      "   > Outer\n> - List\n",
      ">     > ",
      true,
    ],
    [
      "GFM table pipe escapes",
      "| Code |\n| --- |\n",
      "| `First \\| ",
      false,
      "` |",
    ],
    [
      "GFM table backslash and pipe escapes",
      "| Code |\n| --- |\n",
      "| `First " + "\\".repeat(3) + "| ",
      false,
      "` |",
    ],
  ])
    await test(`reading inside ${kind} stays anchored when earlier chunks arrive`, () =>
      withPage(async (page) => {
        const text =
          heading +
          (code ? prefix + "```text\n" : "") +
          Array.from(
            { length: 65 },
            (_, i) => `${prefix}Quote line ${i}. Content to read.${suffix}`,
          ).join("\n") +
          (code ? "\n" + prefix + "```" : "");
        await page.evaluate(async (text) => {
          const f = window.historyFixture;
          f.suffix = {
            seq: 21,
            type: "assistant/chunk",
            data: { turn: 21, step: 0, chunk: { type: "text-delta", text } },
          };
          f.full = {
            ...f.state,
            hasMore: true,
            events: [f.suffix, ...f.events(23, 40)],
          };
          f.reply(f.full);
          await f.painted();
          f.markerRect = () => {
            const root = document.querySelector(
              '[data-message-id^="partial-"] .message-content',
            );
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const index = node.data.indexOf("Quote line 20.");
              if (index < 0) continue;
              const range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              return range.getBoundingClientRect();
            }
            throw Error("reading marker missing");
          };
        }, text);
        await beginOlder(page);
        const before = await page
          .locator(".messages")
          .evaluate(async (node) => {
            const f = window.historyFixture;
            node.scrollTop +=
              f.markerRect().top - node.getBoundingClientRect().top - 25;
            node.dispatchEvent(new Event("scroll"));
            await f.painted();
            return f.markerRect().top - node.getBoundingClientRect().top;
          });
        await page.evaluate(async () => {
          const f = window.historyFixture,
            request = f.olderRequests[0];
          const prefix = {
            seq: 20,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: {
                type: "text-delta",
                text: "Earlier paragraph. ".repeat(300) + "\n\n",
              },
            },
          };
          f.full = {
            ...f.full,
            events: [...f.events(1, 19), prefix, f.suffix, ...f.events(23, 40)],
            eventsRevision: 6,
            historyPage: request.payload,
          };
          f.broadcast(f.full);
          request.resolve({ sessionId: "test", eventsRevision: 6 });
          await f.painted();
        });
        const after = await page
          .locator(".messages")
          .evaluate(
            (node) =>
              window.historyFixture.markerRect().top -
              node.getBoundingClientRect().top,
          );
        assert.ok(
          Math.abs(after - before) < 1,
          `reading position moved by ${after - before}px`,
        );
      }));

  for (const phase of ["streaming", "finishes", "hidden-finishes"])
    for (const paragraph of [0, 20])
      await test(`DSH prefix backfill preserves text within a long reply; phase = ${phase}, paragraph = ${paragraph}`, () =>
        withPage(async (page) => {
          const target =
            `Paragraph ${paragraph}. ` + "Existing content. ".repeat(20);
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            const text =
              "Read **this marker** with `code`.\n\n" +
              Array.from(
                { length: 40 },
                (_, i) => `Paragraph ${i}. ` + "Existing content. ".repeat(20),
              ).join("\n\n");
            fixture.suffix = {
              seq: 21,
              type: "assistant/chunk",
              data: { turn: 21, step: 0, chunk: { type: "text-delta", text } },
            };
            fixture.full = {
              ...fixture.state,
              hasMore: true,
              events: [fixture.suffix, ...fixture.events(23, 40)],
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          });
          await beginOlder(page);
          await page
            .getByText(target, { exact: true })
            .evaluate(async (node) => {
              const container = node.closest(".messages");
              container.scrollTop +=
                node.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                50;
              container.dispatchEvent(new Event("scroll"));
              await window.historyFixture.painted();
            });
          const before = await messageOffset(page, target);
          if (phase === "hidden-finishes")
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          await page.evaluate(async (phase) => {
            const fixture = window.historyFixture,
              request = fixture.olderRequests[0];
            const text =
              "Earlier **paragraph** with `code`. ".repeat(400) + "\n\n";
            const prefix = {
              seq: 20,
              type: "assistant/chunk",
              data: { turn: 21, step: 0, chunk: { type: "text-delta", text } },
            };
            // Prefix backfill and new output can arrive in the same update.
            const tail = {
              seq: 22,
              type: "assistant/chunk",
              data: {
                turn: 21,
                step: 0,
                chunk: {
                  type: "text-delta",
                  text: "\n\nNew live output. ".repeat(10),
                },
              },
            };
            const final = {
              seq: 23,
              type: "assistant/message",
              data: {
                turn: 21,
                step: 0,
                message: {
                  content: [
                    {
                      type: "text",
                      text:
                        text +
                        fixture.suffix.data.chunk.text +
                        tail.data.chunk.text,
                    },
                  ],
                },
              },
            };
            fixture.full = {
              ...fixture.full,
              events: [
                ...fixture.events(1, 19),
                prefix,
                fixture.suffix,
                tail,
                ...(phase === "streaming" ? [] : [final]),
                ...fixture.events(24, 40),
              ],
              eventsRevision: 6,
              historyPage: request.payload,
            };
            fixture.broadcast(fixture.full);
            request.resolve({ sessionId: "test", eventsRevision: 6 });
            await fixture.painted();
          }, phase);
          if (phase === "hidden-finishes")
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          const after = await messageOffset(page, target);
          assert.ok(
            Math.abs(after - before) < 1,
            `existing text moved from ${before}px to ${after}px`,
          );
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            const { events, ...status } = fixture.full;
            fixture.broadcast(status);
            await fixture.painted();
          });
          assert.ok(
            Math.abs((await messageOffset(page, target)) - before) < 1,
            "later metadata must not move the reader again",
          );
        }));

  for (const hidden of [false, true])
    for (const count of [3, 20])
      await test(`page restoration cannot enable follow; initial messages = ${count}, hidden = ${hidden}`, () =>
        withPage(async (page) => {
          await page.evaluate(async (count) => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.state,
              hasMore: true,
              events: fixture.events(61 - count, 60),
            };
            fixture.reply(fixture.full);
            await fixture.painted();
          }, count);
          await beginOlder(page);
          if (hidden)
            await page
              .getByRole("button", { name: "切换会话", exact: true })
              .click();
          await page.evaluate(async () => {
            const fixture = window.historyFixture,
              request = fixture.olderRequests[0];
            fixture.full = {
              ...fixture.full,
              events: fixture.events(31, 60),
              eventsRevision: 6,
              historyPage: request.payload,
            };
            fixture.broadcast(fixture.full);
            request.resolve({ sessionId: "test", eventsRevision: 6 });
            await fixture.painted();
          });
          if (hidden)
            await page.getByRole("button", { name: "关闭会话列表" }).click();
          await page.evaluate(() => window.historyFixture.painted());
          const before = await messageOffset(page, `Message ${61 - count}`);
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.full,
              events: fixture.events(31, 70),
              eventsRevision: 7,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          assert.ok(
            Math.abs(
              (await messageOffset(page, `Message ${61 - count}`)) - before,
            ) < 1,
            "live append must not move the reader without a user scroll",
          );
          // A later deliberate scroll still resumes following normally.
          await page.locator(".messages").evaluate(async (node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event("scroll"));
            await window.historyFixture.painted();
          });
          await page.evaluate(async () => {
            const fixture = window.historyFixture;
            fixture.full = {
              ...fixture.full,
              events: fixture.events(31, 75),
              eventsRevision: 8,
            };
            fixture.broadcast(fixture.full);
            await fixture.painted();
          });
          const after = await viewport(page);
          assert.equal(
            after.top,
            after.height - after.client,
            "manual scrolling can still resume following",
          );
        }));

  for (const phase of ["streaming", "completed", "finishes"])
    await test(`DSH backfilled chunks preserve the reply anchor; phase = ${phase}`, () =>
      withPage(async (page) => {
        await page.evaluate(async (phase) => {
          const fixture = window.historyFixture;
          const chunk = {
            seq: 21,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: { type: "text-delta", text: "Message 21" },
            },
          };
          fixture.full = {
            ...fixture.state,
            hasMore: true,
            events: fixture
              .events(21, 60)
              .filter((event) => event.seq !== 22)
              .map((event) => ({
                ...event,
                data: { ...event.data, turn: event.seq, step: 0 },
              })),
          };
          if (phase !== "completed") fixture.full.events[0] = chunk;
          fixture.reply(fixture.full);
          await fixture.painted();
        }, phase);
        await beginOlder(page);
        const before = await messageOffset(page, "Message 21");
        await page.evaluate(async (phase) => {
          const fixture = window.historyFixture,
            request = fixture.olderRequests[0];
          const older = fixture.events(1, 19).map((event) => ({
            ...event,
            data: { ...event.data, turn: event.seq, step: 0 },
          }));
          const prefix = {
            seq: 20,
            type: "assistant/chunk",
            data: {
              turn: 21,
              step: 0,
              chunk: {
                type: "text-delta",
                text: phase === "completed" ? "Mes" : "Prefix ",
              },
            },
          };
          const final = {
            seq: 22,
            type: "assistant/message",
            data: {
              turn: 21,
              step: 0,
              message: {
                content: [{ type: "text", text: "Prefix Message 21" }],
              },
            },
          };
          fixture.full = {
            ...fixture.full,
            events: [
              ...older,
              prefix,
              fixture.full.events[0],
              ...(phase === "finishes" ? [final] : []),
              ...fixture.full.events.slice(1),
            ],
            eventsRevision: 6,
            historyPage: request.payload,
          };
          fixture.broadcast(fixture.full);
          request.resolve({ sessionId: "test", eventsRevision: 6 });
          await fixture.painted();
        }, phase);
        assert.ok(
          Math.abs(
            (await messageOffset(
              page,
              phase === "completed" ? "Message 21" : "Prefix Message 21",
            )) - before,
          ) < 1,
        );
      }));

  for (const receiptFirst of [false, true])
    await test(`pagination preserves the viewport across status/live updates; receipt first = ${receiptFirst}`, () =>
      withPage(async (page) => {
        await showHistory(page);
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          const { events, ...status } = fixture.full;
          fixture.broadcast(status);
          await fixture.painted();
          // Live output and another page marker must not consume our anchor.
          fixture.full = {
            ...fixture.full,
            events: fixture.events(21, 61),
            eventsRevision: 6,
            historyPage: { requestId: "unrelated", sessionId: "test" },
          };
          fixture.broadcast(fixture.full);
          await fixture.painted();
        });
        const before = await viewport(page);
        const anchorBefore = await messageOffset(page, "Message 21");
        assert.equal(before.top, 0);
        await page.evaluate(async (receiptFirst) => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[0];
          if (receiptFirst) {
            request.resolve({ sessionId: "test", eventsRevision: 7 });
            await fixture.painted();
          }
          fixture.full = {
            ...fixture.full,
            hasMore: false,
            events: fixture.events(1, 61),
            eventsRevision: 7,
            historyPage: request.payload,
          };
          fixture.broadcast(fixture.full);
          await fixture.painted();
          if (!receiptFirst)
            request.resolve({ sessionId: "test", eventsRevision: 7 });
          await fixture.painted();
        }, receiptFirst);
        const after = await viewport(page);
        assert.ok(after.height > before.height);
        assert.ok(
          Math.abs((await messageOffset(page, "Message 21")) - anchorBefore) <
            1,
        );
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          const { events, ...status } = fixture.full;
          fixture.broadcast(status);
          await fixture.painted();
        });
        assert.equal(
          (await viewport(page)).top,
          after.top,
          "do not compensate twice",
        );
      }));

  for (const failure of [false, true])
    await test(`${failure ? "failed" : "no-op"} pagination releases its anchor before live updates and retry`, () =>
      withPage(async (page) => {
        await showHistory(page);
        await page.evaluate(async (failure) => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[0];
          if (failure) request.reject(new Error("History unavailable"));
          else request.resolve(undefined);
          await fixture.painted();
          fixture.full = {
            ...fixture.full,
            events: fixture.events(21, 61),
            eventsRevision: 6,
          };
          fixture.broadcast(fixture.full);
          await fixture.painted();
        }, failure);
        assert.equal((await viewport(page)).top, 0);
        await beginOlder(page);
        const anchorBefore = await messageOffset(page, "Message 21");
        await page.evaluate(async () => {
          const fixture = window.historyFixture;
          const request = fixture.olderRequests[1];
          fixture.full = {
            ...fixture.full,
            events: fixture.events(1, 61),
            eventsRevision: 7,
            historyPage: request.payload,
          };
          request.resolve({ sessionId: "test", eventsRevision: 7 });
          fixture.broadcast(fixture.full);
          await fixture.painted();
        });
        assert.ok(
          Math.abs((await messageOffset(page, "Message 21")) - anchorBefore) <
            1,
        );
      }));

  await test("switching sessions abandons an in-flight page's scroll anchor", () =>
    withPage(async (page) => {
      await showHistory(page);
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.full = {
          ...fixture.full,
          selectedId: "other",
          eventsRevision: 6,
          sessions: [
            { sessionId: "other", title: "Other session", running: false },
          ],
        };
        fixture.broadcast(fixture.full);
        await fixture.painted();
        fixture.olderRequests[0].resolve(undefined);
        await fixture.painted();
      });
      const after = await viewport(page);
      assert.equal(after.top, after.height - after.client);
      await beginOlder(page);
      const anchorBefore = await messageOffset(page, "Message 21");
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        const request = fixture.olderRequests[1];
        fixture.full = {
          ...fixture.full,
          events: fixture.events(1, 60),
          eventsRevision: 7,
          historyPage: request.payload,
        };
        fixture.broadcast(fixture.full);
        request.resolve({ sessionId: "other", eventsRevision: 7 });
        await fixture.painted();
      });
      assert.ok(
        Math.abs((await messageOffset(page, "Message 21")) - anchorBefore) < 1,
      );
    }));

  await test("initial full history hydrates an already-rendered status-only revision", () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.broadcast(fixture.state);
      });
      await expect(page.locator(".welcome")).toBeVisible();
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.reply(fixture.snapshot("Recovered history"));
      });
      await expect(
        page.getByText("Recovered history", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".welcome")).toHaveCount(0);
      // Further snapshots without events must keep the hydrated history.
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.broadcast({ ...fixture.state, hasMore: true });
      });
      await expect(
        page.getByRole("button", { name: "加载更早的消息" }),
      ).toBeVisible();
      await expect(
        page.getByText("Recovered history", { exact: true }),
      ).toHaveCount(1);
    }));

  await test("a delayed older full snapshot cannot overwrite newer history", () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        const fixture = window.historyFixture;
        fixture.broadcast(fixture.snapshot("Current history", 6));
      });
      await expect(
        page.getByText("Current history", { exact: true }),
      ).toBeVisible();
      await page.evaluate(async () => {
        const fixture = window.historyFixture;
        fixture.reply(fixture.snapshot("Stale history", 5));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      await expect(
        page.getByText("Current history", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Stale history", { exact: true }),
      ).toHaveCount(0);
    }));
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null) {
    child.kill();
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
