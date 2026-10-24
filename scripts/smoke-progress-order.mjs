import assert from "node:assert/strict";
import test from "node:test";
import { expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "./electron-test.mjs";
import { createFixture } from "../tests/fixture.mjs";

const fixture = await createFixture();
const data = await mkdtemp(join(tmpdir(), "dsg-progress-order-"));
const ids = Array.from({ length: 6 }, (_, i) => `order-${i}`);
const addSession = (sessionId) =>
  fixture.sessions.set(sessionId, {
    sessionId,
    title: sessionId,
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
for (const id of ids) addSession(id);
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    endpoint: fixture.endpoint,
    enabledProviders: ["dsh"],
    selectedId: ids[0],
    alwaysOnTop: false,
    petPosition: { x: 500, y: 250 },
    sounds: { enabled: false },
  }),
);
const env = { ...process.env, DEEPSEEK_GIRL_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await launchDesktop(env);
  const page = await app.firstWindow();
  // CDP still exercises Chromium's hit testing in a hidden window. Keep real
  // desktop mouse movement from interleaving with this suite's pointer input.
  // Native window visibility/geometry remains covered by smoke-progress.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
    window.show = window.showInactive = () => {};
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const invoke = (action, payload) =>
    page.evaluate(([a, p]) => window.desktop.invoke(a, p), [action, payload]);
  const state = () => invoke("state");
  const stack = page.getByRole("group", { name: "会话气泡" });
  const cards = page.locator(".progress-card");
  const card = (id) => page.locator(`.progress-card[data-session-id="${id}"]`);
  const input = await page.context().newCDPSession(page);
  // A CI runner can take >400ms between mouse commands in a hidden window.
  // That is a real pause to the deck's stale-pointer guard, not a continuous
  // gesture. Timestamp the two ends explicitly while retaining Chromium's
  // native hit testing, pointer events and :hover state. The first event also
  // establishes a fresh origin after assertions/animations paused the pointer.
  let inputTime = 0;
  const gesture = async (from, to, elapsed = 16) => {
    const timestamp = Math.max(Date.now() / 1000, inputTime + 0.016);
    inputTime = timestamp + elapsed / 1000;
    for (const [point, offset] of [
      [from, 0],
      [to, elapsed],
    ])
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        timestamp: timestamp + offset / 1000,
      });
  };
  const settle = () =>
    stack.evaluate((node) =>
      Promise.all(
        node
          .getAnimations({ subtree: true })
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
  let serial = 0;
  const turns = new Map();
  const start = (id) => {
    fixture.sessions.get(id).running = true;
    turns.set(id, ++serial);
    fixture.event(id, "turn/start", { turn: serial });
  };
  const finish = (id) => {
    fixture.sessions.get(id).running = false;
    fixture.event(id, "turn/end", { turn: turns.get(id), reason: "completed" });
  };
  await expect.poll(async () => (await state()).sessions.length).toBe(6);
  const reset = async () => {
    await invoke("section", "chat");
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(
      2,
      (await page.evaluate(() => window.innerHeight)) - 2,
    );
    for (const id of ids) start(id);
    await expect
      .poll(async () => {
        const current = await state();
        return ids.every(
          (id) =>
            current.progressEntries[id]?.active &&
            current.activity[id]?.status === "thinking",
        );
      })
      .toBe(true);
    await invoke("section", null);
    await expect(stack).toHaveAttribute("data-total", String(ids.length));
    await expect(cards).toHaveCount(5);
  };
  // Send deterministic DOM pointer events through React. These tests exercise
  // focus removal and ordering; native pointer geometry remains in smoke-progress.
  const enter = () =>
    stack.evaluate((node) => {
      const r = node.getBoundingClientRect();
      for (const type of ["pointerover", "pointermove"])
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: "mouse",
            clientX: r.right - 20,
            clientY: r.top + 20,
            relatedTarget: document.body,
          }),
        );
    });
  const leave = () =>
    stack.evaluate((node) => {
      const r = node.getBoundingClientRect();
      node.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          clientX: r.left - 20,
          clientY: r.bottom + 20,
          relatedTarget: document.body,
        }),
      );
    });

  await test("a restarted automatically selected bubble yields the front to completed work", async () => {
    await reset();
    finish(ids[0]);
    await expect(card(ids[0])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    finish(ids[1]);
    await expect(card(ids[1])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
    start(ids[1]);
    await expect(card(ids[1])).toContainText("正在思考");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    await expect(cards.last()).toHaveAttribute("data-session-id", ids[0]);
    await expect(cards.last()).toContainText("已完成");
    await expect(cards).toHaveCount(5);
  });

  await test("restart fallback waits for pointer browsing without moving the click target", async () => {
    await reset();
    finish(ids[0]);
    await expect(card(ids[0])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    finish(ids[1]);
    await expect(card(ids[1])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
    await enter();
    await expect(stack).toHaveClass(/is-browsing/);
    const before = await card(ids[1]).boundingBox();
    start(ids[1]);
    await expect(card(ids[1])).toContainText("正在思考");
    await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
    assert.deepEqual(await card(ids[1]).boundingBox(), before);
    await leave();
    await expect(stack).not.toHaveClass(/is-browsing/);
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    await expect(cards.last()).toHaveAttribute("data-session-id", ids[0]);
  });

  await test("removing the keyboard-focused card during mouse rotation clears keyboard browsing", async () => {
    await reset();
    await page.locator(".pet-progress-bubble.is-active").focus();
    await page.keyboard.press("Home");
    await expect(stack).toHaveAttribute("data-selected-index", "0");
    await expect(page.locator(".pet-progress-bubble.is-active")).toBeFocused();
    await enter();
    await stack.evaluate((node) => {
      const r = node.getBoundingClientRect();
      node.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX: r.right - 145,
          clientY: r.top + 145,
        }),
      );
    });
    await expect(stack).toHaveAttribute("data-selected-index", "5");
    assert.equal(
      await page.evaluate(() => document.activeElement.tagName),
      "BODY",
    );
    await expect(stack).toHaveClass(/is-browsing/); // pointer is still inside
    await leave();
    await expect(stack).not.toHaveClass(/is-browsing/);
    const selected = await stack.getAttribute("data-selected-session");
    const done = ids.find((id) => id !== selected);
    finish(done);
    await expect(stack).toHaveAttribute("data-selected-session", done);
    await expect(cards.last()).toHaveAttribute("data-session-id", done);
    await expect(cards).toHaveCount(5);
  });

  await test("keyboard navigation transfers focus before validating browsing and preserves a manual selection", async () => {
    await reset();
    finish(ids[0]);
    await expect(card(ids[0])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    await page.locator(".pet-progress-bubble.is-active").focus();
    for (const [key, index] of [
      ["Home", 0],
      ["End", 5],
      ["Home", 0],
    ]) {
      await page.keyboard.press(key);
      await expect(stack).toHaveAttribute("data-selected-index", String(index));
      await expect(
        page.locator(".pet-progress-bubble.is-active"),
      ).toBeFocused();
      await expect(stack).toHaveClass(/is-browsing/);
    }
    const manual = await stack.getAttribute("data-selected-session");
    await page.evaluate(() => document.activeElement.blur());
    await expect(stack).not.toHaveClass(/is-browsing/);
    await expect(stack).toHaveAttribute("data-selected-session", manual);
    start(ids[0]);
    await expect(card(ids[0])).toContainText("正在思考");
    await expect(stack).toHaveAttribute("data-selected-session", manual);
  });

  for (const exit of ["page", "window"]) {
    await test(`leaving through a click-through gap toward the ${exit} releases pointer browsing`, async () => {
      await reset();
      // Use native hit testing: the gap is inside the stack's rectangle but
      // belongs to the desktop underneath, so it stops delivering stack events.
      await page.locator(".pet-progress-bubble.is-active").hover();
      await expect(stack).toHaveClass(/is-browsing/);
      const selected = await stack.getAttribute("data-selected-session");
      const box = await stack.boundingBox();
      const gap = { x: box.x + 2, y: box.y + 2 };
      assert.equal(
        await page.evaluate(
          ({ x, y }) =>
            !!document.elementFromPoint(x, y)?.closest(".pet-progress-stack"),
          gap,
        ),
        false,
      );
      await page.mouse.move(gap.x, gap.y);
      await expect
        .poll(() => stack.evaluate((node) => node.matches(":hover")))
        .toBe(false);
      const finished = ids.find((id) => id !== selected);
      finish(finished);
      await expect
        .poll(async () => (await state()).progressEntries[finished]?.status)
        .toBe("done");
      if (exit === "window") await page.mouse.move(-10, -10);
      else
        await page.mouse.move(2, (await page.evaluate(() => innerHeight)) - 2);
      await expect(stack).not.toHaveClass(/is-browsing/);
      await expect(stack).toHaveAttribute("data-selected-session", finished);
      await expect(cards.last()).toHaveAttribute("data-session-id", finished);
      await expect(cards).toHaveCount(5);
      await expect(
        page.locator(".progress-card:not(.is-active)").first(),
      ).toHaveCSS("opacity", "1");
    });
  }

  await test("mouse-dismissed selection cannot revive when its next task appears", async () => {
    await reset();
    finish(ids[0]);
    await expect(card(ids[0])).toContainText("已完成");
    finish(ids[1]);
    await expect(card(ids[1])).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
    // Activate the close handler without keyboard focus or a pointer gesture
    // choosing another card, isolating selection reconciliation from hit testing.
    await page
      .locator(".progress-dismiss.is-active")
      .evaluate((node) => node.click());
    await expect(stack).toHaveAttribute("data-total", "5");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    await expect(card(ids[1])).toHaveCount(0);
    start(ids[1]);
    await expect(stack).toHaveAttribute("data-total", "6");
    await expect(card(ids[1])).toContainText("正在思考");
    await expect(stack).toHaveAttribute("data-selected-session", ids[0]);
    await expect(cards.last()).toHaveAttribute("data-session-id", ids[0]);
    await expect(cards.last()).toContainText("已完成");
    await expect(cards).toHaveCount(5);
  });

  await test("pointer movement inside the same card recovers browsing after window blur", async () => {
    await reset();
    await page.locator(".pet-progress-bubble.is-active").hover();
    await expect(stack).toHaveClass(/is-browsing/);
    const selected = await stack.getAttribute("data-selected-session");
    const box = await card(selected).boundingBox();
    // Playwright emulates focus, so inject the window lifecycle events while
    // keeping Chromium's actual pointer hit testing and :hover state intact.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(stack).not.toHaveClass(/is-browsing/);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await stack.evaluate((node) => node.matches(":hover")), true);
    await page.mouse.move(
      box.x + box.width / 2 - 1,
      box.y + box.height / 2 + 1,
    );
    await expect(stack).toHaveClass(/is-browsing/);
    await expect(stack).toHaveAttribute("data-selected-session", selected);
    await expect(
      page.locator(".progress-card:not(.is-active)").first(),
    ).toHaveCSS("opacity", "0.1");
    const finished = await page
      .locator(".progress-card:not(.is-active)")
      .first()
      .getAttribute("data-session-id");
    finish(finished);
    await expect(card(finished)).toContainText("已完成");
    await expect(stack).toHaveAttribute("data-selected-session", selected);
    await expect(cards).toHaveCount(5);
    await page.mouse.move(2, (await page.evaluate(() => innerHeight)) - 2);
    await expect(stack).not.toHaveClass(/is-browsing/);
    await expect(stack).toHaveAttribute("data-selected-session", finished);
    await expect(cards.last()).toHaveAttribute("data-session-id", finished);
  });

  for (const key of ["Space", "Enter"]) {
    await test(`${key} opens the current selection after the pointer leaves keyboard focus behind`, async () => {
      await reset();
      await page.locator(".pet-progress-bubble.is-active").focus();
      await page.keyboard.press("Home");
      await expect(stack).toHaveAttribute("data-selected-index", "0");
      const focused = await stack.getAttribute("data-selected-session");
      const target = page.locator(".pet-progress-bubble.is-active");
      await target.hover();
      const box = await target.boundingBox();
      const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await gesture(origin, { x: origin.x - 25, y: origin.y + 25 });
      await expect(stack).toHaveAttribute("data-selected-index", "1");
      const selected = await stack.getAttribute("data-selected-session");
      assert.notEqual(selected, focused);
      assert.equal(
        await page.evaluate(() => document.activeElement.dataset.sessionId),
        focused,
      );
      await page.keyboard.press(key);
      await expect
        .poll(async () => (await state()).surface.section)
        .toBe("chat");
      assert.equal((await state()).selectedId, selected);
    });

    await test(`${key} on the close control dismisses without opening or cancelling the session`, async () => {
      await reset();
      const selected = await stack.getAttribute("data-selected-session");
      await page.locator(".progress-dismiss.is-active").focus();
      await page.keyboard.press(key);
      await expect(stack).toHaveAttribute("data-total", "5");
      await expect(card(selected)).toHaveCount(0);
      await expect(
        page.locator(".pet-progress-bubble.is-active"),
      ).toBeFocused();
      const current = await state();
      assert.equal(current.surface.section, null);
      assert.equal(
        current.sessions.find((row) => row.sessionId === selected).running,
        true,
      );
      assert.equal(current.progressEntries[selected].hidden, true);
    });
  }

  await test("a paused pointer establishes a new origin before continuous movement resumes rotation", async () => {
    await reset();
    const target = page.locator(".pet-progress-bubble.is-active");
    await target.hover();
    const box = await target.boundingBox();
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const paused = { x: origin.x + 25, y: origin.y - 25 };
    const resumed = { x: paused.x + 25, y: paused.y - 25 };
    const before = Number(await stack.getAttribute("data-selected-index"));
    await gesture(origin, paused, 500);
    await expect(stack).toHaveAttribute("data-selected-index", String(before));
    await gesture(paused, resumed);
    await expect(stack).toHaveAttribute(
      "data-selected-index",
      String(before - 1),
    );
    await expect(cards).toHaveCount(5);
  });

  const movePet = async (anchor) => {
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
    const surface = (await state()).surface;
    await invoke("drag:start", {
      x: bounds.x + surface.pet.x + 150,
      y: bounds.y + surface.pet.y + 150,
    });
    try {
      await invoke("drag:move", { x: anchor.x + 150, y: anchor.y + 150 });
    } finally {
      await invoke("drag:end");
    }
  };
  for (const [count, headroom, action] of [
    [5, null, "open"],
    [5, null, "dismiss"],
    [2, 60, "browse"],
    [3, null, "open"],
  ]) {
    await test(`${action} keeps its pointer target when ${count} hovered bubbles gain a session`, async () => {
      await reset();
      for (const id of ids.slice(count)) await invoke("dismissProgress", id);
      await expect(stack).toHaveAttribute("data-total", String(count));
      const bounds = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds(),
      );
      const surface = (await state()).surface;
      const anchor = {
        x: bounds.x + surface.pet.x,
        y: bounds.y + surface.pet.y,
      };
      try {
        if (headroom !== null) {
          const area = await app.evaluate(
            ({ screen }, anchor) =>
              screen.getDisplayNearestPoint(anchor).workArea,
            anchor,
          );
          await movePet({ x: anchor.x, y: area.y + headroom });
        }
        await expect(cards).toHaveCount(count);
        await settle();
        const selected = await page
          .locator(".pet-progress-bubble")
          .first()
          .getAttribute("data-session-id");
        const bubble = page.locator(
          `.pet-progress-bubble[data-session-id="${selected}"]`,
        );
        const before = await bubble.boundingBox();
        // The exposed heading strip is a body hit, away from the close button.
        let point = { x: before.x + before.width / 2, y: before.y + 10 };
        await page.mouse.move(point.x, point.y);
        await expect(stack).toHaveAttribute("data-selected-session", selected);
        if (action === "dismiss") {
          const close = await page
            .locator(".progress-dismiss.is-active")
            .boundingBox();
          point = {
            x: close.x + close.width / 2,
            y: close.y + close.height / 2,
          };
          await page.mouse.move(point.x, point.y);
        }
        start(ids[count]);
        await expect(stack).toHaveAttribute("data-total", String(count + 1));
        await settle();
        await expect(cards).toHaveCount(count);
        await expect(stack).toHaveAttribute("data-selected-session", selected);
        assert.deepEqual(
          await bubble.boundingBox(),
          before,
          "the selected bubble stays at the pointer",
        );
        const hit = await page.evaluate(({ x, y }) => {
          const node = document
            .elementFromPoint(x, y)
            ?.closest("[data-session-id]");
          return {
            id: node?.dataset.sessionId,
            close: !!node?.matches(".progress-dismiss"),
          };
        }, point);
        assert.deepEqual(hit, { id: selected, close: action === "dismiss" });
        if (action === "browse") {
          // Newly added work remains reachable without leaving the hover.
          for (let index = 1; index <= count; index++) {
            await gesture(
              { x: point.x - 25 * (index - 1), y: point.y + 25 * (index - 1) },
              { x: point.x - 25 * index, y: point.y + 25 * index },
            );
            await expect(stack).toHaveAttribute(
              "data-selected-index",
              String(index),
            );
            // Deliberate rotation animates the next card into the held slot.
            await settle();
            assert.deepEqual(
              await page
                .locator(".pet-progress-bubble.is-active")
                .boundingBox(),
              before,
            );
            await expect(cards).toHaveCount(count);
          }
          await expect(stack).toHaveAttribute(
            "data-selected-session",
            ids[count],
          );
          await page.mouse.move(
            2,
            (await page.evaluate(() => innerHeight)) - 2,
          );
          await expect(stack).not.toHaveClass(/is-browsing/);
          await settle();
          await expect(cards.last()).toHaveAttribute(
            "data-session-id",
            ids[count],
          );
          const resting = await page
            .locator(".pet-progress-bubble.is-active")
            .boundingBox();
          await page.locator(".pet-progress-bubble.is-active").hover();
          assert.deepEqual(
            await page.locator(".pet-progress-bubble.is-active").boundingBox(),
            resting,
          );
        } else {
          await page.mouse.click(point.x, point.y);
          if (action === "dismiss") {
            await expect(card(selected)).toHaveCount(0);
            await expect(stack).toHaveAttribute("data-total", String(count));
            const current = await state();
            assert.equal(current.progressEntries[selected].hidden, true);
            assert.equal(
              current.sessions.find((row) => row.sessionId === selected)
                .running,
              true,
            );
            assert.equal(current.surface.section, null);
          } else {
            await expect
              .poll(async () => (await state()).surface.section)
              .toBe("chat");
            assert.equal((await state()).selectedId, selected);
          }
        }
      } finally {
        if (headroom !== null) await movePet(anchor);
      }
    });
  }
  for (const [headroom, capacity] of [
    [0, 1],
    [60, 2],
  ]) {
    await test(`four sessions remain browsable when only ${capacity} card(s) fit above the pet`, async () => {
      await reset();
      for (const id of ids.slice(4)) await invoke("dismissProgress", id);
      await expect(stack).toHaveAttribute("data-total", "4");
      const bounds = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds(),
      );
      const surface = (await state()).surface;
      const anchor = {
        x: bounds.x + surface.pet.x,
        y: bounds.y + surface.pet.y,
      };
      const area = await app.evaluate(
        ({ screen }, anchor) => screen.getDisplayNearestPoint(anchor).workArea,
        anchor,
      );
      try {
        await movePet({ x: anchor.x, y: area.y + headroom });
        await expect(cards).toHaveCount(capacity);
        await expect(stack).toHaveAttribute("data-selected-index", "3");
        const visited = new Set([
          await stack.getAttribute("data-selected-session"),
        ]);
        for (const direction of [1, 1, 1, -1, -1, -1]) {
          await page.mouse.move(
            2,
            (await page.evaluate(() => innerHeight)) - 2,
          );
          const before = Number(
            await stack.getAttribute("data-selected-index"),
          );
          const target = page.locator(".pet-progress-bubble.is-active");
          await target.hover();
          // Entry must keep a compact deck's selection and front slot stable.
          await expect(stack).toHaveAttribute(
            "data-selected-index",
            String(before),
          );
          const box = await target.boundingBox();
          const origin = {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          };
          await gesture(origin, {
            x: origin.x + 25 * direction,
            y: origin.y - 25 * direction,
          });
          await expect(stack).toHaveAttribute(
            "data-selected-index",
            String(before - direction),
          );
          await expect(cards).toHaveCount(capacity);
          const selected = await stack.getAttribute("data-selected-session");
          visited.add(selected);
          await expect(cards.last()).toHaveAttribute(
            "data-session-id",
            selected,
          );
        }
        assert.deepEqual([...visited].sort(), ids.slice(0, 4).sort());
        const caption = page.locator(".progress-deck-caption");
        await expect(caption).toContainText("4 / 4");
        await expect(caption).toContainText("沿斜向移动切换");
        const label = await caption.boundingBox();
        const character = await page.locator(".pet-character").boundingBox();
        assert.ok(
          label.y + label.height <= character.y,
          "the caption stays above the pet",
        );
        if (capacity === 1) {
          const box = await cards.first().boundingBox();
          assert.ok(
            label.x >= box.x && label.x + label.width <= box.x + box.width,
          );
          assert.ok(
            label.y >= box.y && label.y + label.height <= box.y + box.height,
          );
        }
        await page.mouse.move(2, (await page.evaluate(() => innerHeight)) - 2);
        await expect(caption).toContainText(`已折叠 ${4 - capacity} 个`);
      } finally {
        await movePet(anchor);
      }
      // Once all four cards fit, direct hover selection works again.
      await expect(cards).toHaveCount(4);
      await settle();
      const rear = page.locator(".pet-progress-bubble").first();
      const rearId = await rear.getAttribute("data-session-id");
      const box = await rear.boundingBox();
      assert.equal(
        await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest("[data-session-id]")
              ?.dataset.sessionId,
          { x: box.x + box.width - 6, y: box.y + 6 },
        ),
        rearId,
      );
      await page.mouse.move(box.x + box.width - 6, box.y + 6);
      await expect(stack).toHaveAttribute("data-selected-session", rearId);
      await expect(rear).toHaveAttribute("title", "点击打开对应对话");
    });
  }

  // Keep more than five sessions after dismissal: a stale selection in a
  // large deck otherwise holds the physical front slot over completed work.
  ids.push("order-6");
  addSession(ids.at(-1));
  fixture.push("host", { type: "host/session-added", sessionId: ids.at(-1) });
  await expect.poll(async () => (await state()).sessions.length).toBe(7);
  for (const manual of [false, true]) {
    await test(`a replacement after mouse dismissal ${manual ? "respects a later manual choice" : "yields to completed work when restarted"}`, async () => {
      await reset();
      for (const id of ids.slice(0, 3)) {
        finish(id);
        await expect(card(id)).toContainText("已完成");
        await expect(stack).toHaveAttribute("data-selected-session", id);
      }
      await page
        .locator(".progress-dismiss.is-active")
        .evaluate((node) => node.click());
      await expect(stack).toHaveAttribute("data-total", "6");
      await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
      if (manual) {
        await page.locator(".pet-progress-bubble.is-active").focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("End");
        await expect(stack).toHaveAttribute("data-selected-session", ids[1]);
        await expect(
          page.locator(".pet-progress-bubble.is-active"),
        ).toBeFocused();
        await page.evaluate(() => document.activeElement.blur());
        await expect(stack).not.toHaveClass(/is-browsing/);
      }
      start(ids[1]);
      await expect(card(ids[1])).toContainText("正在思考");
      const front = manual ? ids[1] : ids[0];
      await expect(stack).toHaveAttribute("data-selected-session", front);
      await expect(cards.last()).toHaveAttribute("data-session-id", front);
      await expect(cards.last()).toContainText(manual ? "正在思考" : "已完成");
      await expect(cards).toHaveCount(5);
    });
  }
  assert.deepEqual(errors, []);
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
