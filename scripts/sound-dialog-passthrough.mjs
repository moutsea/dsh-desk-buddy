import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openSoundEvents } from "./sound-settings-dialog.mjs";

export async function checkSoundDialogPassthrough(app, page) {
  // CDP mouse input does not move the OS cursor on every platform. Keep the
  // main-process panel guard at the same point as the renderer's test pointer.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const getCursor = screen.getCursorScreenPoint;
    const setIgnore = window.setIgnoreMouseEvents;
    const probe = { point: { x: 0, y: 0 }, ignored: null, changes: [] };
    screen.getCursorScreenPoint = () => {
      const bounds = window.getBounds();
      return {
        x: bounds.x + probe.point.x,
        y: bounds.y + probe.point.y,
      };
    };
    window.setIgnoreMouseEvents = (ignore, options) => {
      probe.ignored = ignore;
      probe.changes.push(ignore);
      return setIgnore.call(window, ignore, options);
    };
    probe.restore = () => {
      screen.getCursorScreenPoint = getCursor;
      window.setIgnoreMouseEvents = setIgnore;
    };
    globalThis.soundDialogMouseProbe = probe;
  });
  await page.evaluate(() => {
    const probe = { stationary: false, point: null, closes: 0 };
    const move = (event) => {
      // Some platforms synthesize a move when the top layer changes. Prevent
      // that fallback from hiding missing capture updates on open, close or restore.
      if (probe.stationary) event.stopImmediatePropagation();
    };
    const boundary = (event) => {
      // The OS cursor can emit boundary events at a different position from CDP.
      // Preserve intentional leaves and same-position top-layer events, allowing
      // one CSS pixel for Chromium's rounding of fractional test coordinates.
      if (
        probe.stationary &&
        probe.point &&
        (Math.abs(event.clientX - probe.point.x) > 1 ||
          Math.abs(event.clientY - probe.point.y) > 1)
      )
        event.stopImmediatePropagation();
    };
    const close = () => probe.closes++;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseout", boundary, true);
    document.addEventListener("mouseleave", boundary, true);
    document.addEventListener("close", close, true);
    probe.restore = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseout", boundary, true);
      document.removeEventListener("mouseleave", boundary, true);
      document.removeEventListener("close", close, true);
    };
    window.soundDialogMouseProbe = probe;
  });
  const movePointer = async (x, y) => {
    await page.evaluate(
      (point) => {
        window.soundDialogMouseProbe.point = point;
      },
      { x, y },
    );
    await page.mouse.move(x, y);
  };
  const settlePassthrough = () =>
    page.evaluate(async () => {
      // Closing reads the native cursor before writing capture. Drain both IPC
      // steps, including cases where the correct native state does not change.
      await window.desktop.invoke("state");
      await window.desktop.invoke("state");
    });
  try {
    const boundaryDelivery = await page.evaluate(() => {
      const probe = window.soundDialogMouseProbe;
      // Exercise the capture filter through DOM delivery, outside React's root
      // so the harness check cannot change the app's mouse-capture state.
      const target = document.body.appendChild(document.createElement("span"));
      const delivered = [];
      const types = ["mouseout", "mouseleave"];
      for (const type of types)
        target.addEventListener(type, (event) => delivered.push(event.type));
      const dispatch = (x, y) => {
        delivered.length = 0;
        for (const type of types)
          target.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }),
          );
        return [...delivered];
      };
      try {
        probe.point = { x: 10.5, y: 20.5 };
        probe.stationary = true;
        const unrelated = dispatch(100, 100);
        const samePosition = dispatch(10.5, 20.5);
        const rounded = dispatch(10, 20);
        probe.stationary = false;
        const intentionalLeave = dispatch(-10, -10);
        return { unrelated, samePosition, rounded, intentionalLeave };
      } finally {
        target.remove();
        probe.stationary = false;
        probe.point = null;
      }
    });
    assert.deepEqual(boundaryDelivery, {
      unrelated: [],
      samePosition: ["mouseout", "mouseleave"],
      rounded: ["mouseout", "mouseleave"],
      intentionalLeave: ["mouseout", "mouseleave"],
    });
    // Establish an observed native state even if capture was already enabled.
    await page.evaluate(async () => {
      await window.desktop.invoke("passthrough", true);
      await window.desktop.invoke("passthrough", false);
    });
    const transparent = await page.evaluate(() => ({
      x: innerWidth - 2,
      y: 2,
    }));
    await app.evaluate((_, point) => {
      globalThis.soundDialogMouseProbe.point = point;
    }, transparent);
    await movePointer(transparent.x, transparent.y);
    await expect
      .poll(() => app.evaluate(() => globalThis.soundDialogMouseProbe.ignored))
      .toBe(true);
    await page.evaluate(() => {
      window.soundDialogMouseProbe.stationary = true;
    });
    const entry = page.getByRole("button", { name: /^互动声音设置/ });
    const dialog = page.getByRole("dialog", {
      name: "互动声音设置",
      exact: true,
    });
    for (const key of ["Enter", "Space"]) {
      await entry.focus();
      await page.keyboard.press(key);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "关闭互动声音设置" }),
      ).toBeFocused();
      await expect
        .poll(
          () => app.evaluate(() => globalThis.soundDialogMouseProbe.ignored),
          {
            message: `${key}: keyboard opening must capture the stationary pointer`,
          },
        )
        .toBe(false);
      const closes = await page.evaluate(
        () => window.soundDialogMouseProbe.closes,
      );
      await page.mouse.down();
      await page.mouse.up();
      await expect(dialog).not.toBeVisible();
      await page.waitForFunction(
        (closes) => window.soundDialogMouseProbe.closes > closes,
        closes,
      );
      await settlePassthrough();
      assert.equal(
        await app.evaluate(() => globalThis.soundDialogMouseProbe.ignored),
        true,
        `${key}: stationary backdrop dismissal restores passthrough`,
      );
      await expect(entry).toBeFocused();
    }
    for (const [area, dismissal, ignored] of [
      ["transparent", "click", true],
      ["transparent", "Escape", true],
      ["panel", "click", false],
      ["panel", "Escape", false],
      ["pet", "Escape", false],
      ["close", "click", false],
    ]) {
      await page.evaluate(() => {
        window.soundDialogMouseProbe.stationary = false;
      });
      const dialog = await openSoundEvents(page);
      const point = await page.evaluate((area) => {
        if (area === "transparent") return { x: innerWidth - 2, y: 2 };
        const element = document.querySelector(
          area === "panel"
            ? ".sound-dialog-shade"
            : area === "pet"
              ? ".pet-character"
              : ".sound-dialog-close",
        );
        const box = element.getBoundingClientRect();
        return {
          x: box.x + (area === "panel" ? 4 : box.width / 2),
          y: box.y + box.height / 2,
        };
      }, area);
      await app.evaluate((_, point) => {
        globalThis.soundDialogMouseProbe.point = point;
      }, point);
      await movePointer(point.x, point.y);
      await settlePassthrough();
      assert.equal(
        await app.evaluate(() => globalThis.soundDialogMouseProbe.ignored),
        false,
      );
      await app.evaluate(() => {
        globalThis.soundDialogMouseProbe.changes = [];
      });
      const closes = await page.evaluate(() => {
        window.soundDialogMouseProbe.stationary = true;
        return window.soundDialogMouseProbe.closes;
      });
      if (dismissal === "Escape") await page.keyboard.press("Escape");
      else {
        // mouse.click()/locator.click() inject a move that can mask this bug.
        await page.mouse.down();
        await page.mouse.up();
      }
      await expect(dialog).not.toBeVisible();
      await page.waitForFunction(
        (closes) => window.soundDialogMouseProbe.closes > closes,
        closes,
      );
      // Drain earlier renderer IPC after the native close event has run.
      await settlePassthrough();
      const result = await app.evaluate(() => ({
        ignored: globalThis.soundDialogMouseProbe.ignored,
        changes: globalThis.soundDialogMouseProbe.changes,
      }));
      assert.equal(
        result.ignored,
        ignored,
        `${area}/${dismissal}: passthrough`,
      );
      if (!ignored)
        assert.ok(
          !result.changes.includes(true),
          `${area}/${dismissal}: interactive content must retain mouse capture`,
        );
      await expect(page.locator(".companion-surface")).toHaveAttribute(
        "data-section",
        "settings",
      );
    }
    for (const [show, area, dismissal] of ["showInactive", "show"].flatMap(
      (show) =>
        ["pet", "transparent"].flatMap((area) =>
          ["click", "Escape", "collapse", "chat"].map((dismissal) => [
            show,
            area,
            dismissal,
          ]),
        ),
    )) {
      const scenario = `${show}/${area}/${dismissal}`;
      const unmount = dismissal === "collapse" || dismissal === "chat";
      const nextSection =
        dismissal === "collapse" ? null : unmount ? "chat" : "settings";
      const point =
        area === "transparent"
          ? transparent
          : await page.locator(".pet-character").evaluate((element) => {
              const box = element.getBoundingClientRect();
              return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            });
      await page.evaluate(() => {
        window.soundDialogMouseProbe.stationary = false;
      });
      await openSoundEvents(page);
      await app.evaluate(() => {
        globalThis.soundDialogMouseProbe.point = { x: -10, y: -10 };
        globalThis.soundDialogMouseProbe.changes = [];
      });
      await movePointer(-10, -10);
      await settlePassthrough();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].hide(),
      );
      await page.evaluate(() => {
        window.soundDialogMouseProbe.stationary = true;
      });
      // Move while hidden, then restore under a stationary pointer. Block
      // synthesized mousemoves so restoring cannot rely on their side effects.
      await app.evaluate((_, point) => {
        globalThis.soundDialogMouseProbe.point = point;
      }, point);
      await movePointer(point.x, point.y);
      await app.evaluate(({ BrowserWindow }, show) => {
        BrowserWindow.getAllWindows()[0][show]();
      }, show);
      await expect(dialog).toBeVisible();
      await settlePassthrough();
      const restored = await app.evaluate(() => ({
        ignored: globalThis.soundDialogMouseProbe.ignored,
        changes: globalThis.soundDialogMouseProbe.changes,
      }));
      assert.equal(
        restored.ignored,
        false,
        `${scenario}: restored modal captures clicks`,
      );
      assert.ok(
        !restored.changes.includes(true),
        `${scenario}: leaving or hiding an open modal must not enable passthrough`,
      );
      const closes = await page.evaluate(
        () => window.soundDialogMouseProbe.closes,
      );
      if (unmount) {
        // Global shortcut/tray collapse and DSH's chat action use showSection,
        // which unmounts SoundSettings without firing the dialog's close event.
        await page.evaluate(
          (section) => window.desktop.invoke("section", section),
          nextSection,
        );
      } else if (dismissal === "Escape") await page.keyboard.press("Escape");
      else {
        await page.mouse.down();
        await page.mouse.up();
      }
      await expect(dialog).not.toBeVisible();
      if (unmount) {
        assert.equal(
          await page.evaluate(() => window.soundDialogMouseProbe.closes),
          closes,
          `${scenario}: unmounting must exercise the path without a native close event`,
        );
        await expect(page.locator("dialog")).toHaveCount(0);
      } else {
        await page.waitForFunction(
          (closes) => window.soundDialogMouseProbe.closes > closes,
          closes,
        );
      }
      await settlePassthrough();
      assert.equal(
        await app.evaluate(() => globalThis.soundDialogMouseProbe.ignored),
        area === "transparent",
        `${scenario}: stationary dismissal preserves capture over interactive content`,
      );
      if (area === "pet") {
        assert.ok(
          !(
            await app.evaluate(() => globalThis.soundDialogMouseProbe.changes)
          ).includes(true),
          `${scenario}: the pet must never lose mouse capture`,
        );
      }
      if (nextSection) {
        await expect(page.locator(".companion-surface")).toHaveAttribute(
          "data-section",
          nextSection,
        );
      } else {
        await expect(page.locator(".companion-surface")).not.toHaveAttribute(
          "data-section",
        );
      }
      if (unmount) {
        await page.evaluate(() => window.desktop.invoke("section", "settings"));
        await expect(entry).toBeVisible();
        await settlePassthrough();
      }
    }
    for (const next of ["reopen", "pet", "transparent"]) {
      await page.evaluate(() => {
        window.soundDialogMouseProbe.stationary = false;
      });
      await openSoundEvents(page);
      const petPoint = await page
        .locator(".pet-character")
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
      const previousPoint = next === "transparent" ? petPoint : transparent;
      await app.evaluate((_, point) => {
        globalThis.soundDialogMouseProbe.point = point;
      }, previousPoint);
      await movePointer(previousPoint.x, previousPoint.y);
      await settlePassthrough();
      await app.evaluate(() => {
        globalThis.soundDialogMouseProbe.changes = [];
      });
      const closes = await page.evaluate(
        ({ next, point }) => {
          const probe = window.soundDialogMouseProbe;
          probe.stationary = true;
          const modal = document.querySelector("dialog");
          modal.addEventListener(
            "close",
            () => {
              // The document's close handler has sent its cursor query, but its
              // reply cannot run until this event returns. Deliver a newer intent.
              if (next === "reopen") modal.showModal();
              else {
                // Keep the native probe at the older point to model an in-flight
                // cursor reply arriving after a newer renderer mousemove.
                probe.stationary = false;
                probe.point = point;
                document.elementFromPoint(point.x, point.y).dispatchEvent(
                  new MouseEvent("mousemove", {
                    bubbles: true,
                    clientX: point.x,
                    clientY: point.y,
                  }),
                );
                probe.stationary = true;
              }
            },
            { once: true },
          );
          return probe.closes;
        },
        { next, point: next === "pet" ? petPoint : transparent },
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (closes) => window.soundDialogMouseProbe.closes > closes,
        closes,
      );
      await settlePassthrough();
      assert.equal(
        await app.evaluate(() => globalThis.soundDialogMouseProbe.ignored),
        next === "transparent",
        `${next}: a late cursor reply must not overwrite newer mouse or modal state`,
      );
      if (next !== "transparent") {
        assert.ok(
          !(
            await app.evaluate(() => globalThis.soundDialogMouseProbe.changes)
          ).includes(true),
          `${next}: capture must remain enabled`,
        );
      }
      if (next === "reopen") {
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await expect(dialog).not.toBeVisible();
      await settlePassthrough();
    }
    console.log(
      "Sound dialog passthrough passed: boundary input isolation preserves same-position, rounded and intentional leave events; 24 stationary-pointer cases covering Enter/Space opening, backdrop/Escape/close-button dismissal and hide/show/showInactive restoration over transparent space and the pet, including settings collapse and switching to chat without a close event; 3 in-flight cursor reply cases preserve newer mouse and modal state.",
    );
  } finally {
    await page.evaluate(() => {
      window.soundDialogMouseProbe.restore();
      delete window.soundDialogMouseProbe;
    });
    await app.evaluate(() => {
      globalThis.soundDialogMouseProbe.restore();
      delete globalThis.soundDialogMouseProbe;
    });
  }
}
