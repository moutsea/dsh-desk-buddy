import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  desktopLayout,
  PET_SIZE,
  normalizePetScale,
  petSize,
  resizedPetAnchor,
  CHAT_SIZES,
  normalizeChatSize,
} from "../shared/desktop-layout.mjs";
import {
  CHARACTER_LAYOUT,
  characterPose,
} from "../shared/character-layout.mjs";
import { EXPRESSIONS } from "../shared/expressions.mjs";
import { motionKeyframes, MOTIONS } from "../shared/motions.mjs";
const registration = JSON.parse(
  readFileSync(
    new URL(
      "../public/characters/deepseek-girl/animations/registration.json",
      import.meta.url,
    ),
  ),
);

test("all 19 static figures and 76 animation frames share visible height and feet", () => {
  const near = (a, b) =>
    assert.ok(Math.abs(a - b) < 0.00001, `${a} should equal ${b}`);
  for (const { id } of EXPRESSIONS) {
    const item = registration[id];
    assert.equal(item.frames.length, 4);
    for (const [index, box] of [item.static, ...item.frames].entries()) {
      const frame = index - 1;
      const sx = index === 0 ? 0 : ((frame % 2) * item.width) / 2;
      const sy = index === 0 ? 0 : (Math.floor(frame / 2) * item.height) / 2;
      const pose = characterPose(box, sx, sy);
      near((sx + box.footX) * pose.scale + pose.x, CHARACTER_LAYOUT.footX);
      near((sy + box.footY) * pose.scale + pose.y, CHARACTER_LAYOUT.footY);
      near(
        (box.footY - box.bodyTop) * pose.scale,
        CHARACTER_LAYOUT.figureHeight,
      );
      assert.ok(Number.isFinite(box.bodyTop) && box.footY > box.bodyTop, id);
    }
    const keyframes = motionKeyframes(id, item.width, item.height, item);
    for (const [n, [frame]] of MOTIONS[id].sequence.entries()) {
      assert.equal(
        keyframes[n].transform,
        characterPose(
          item.frames[frame],
          ((frame % 2) * item.width) / 2,
          (Math.floor(frame / 2) * item.height) / 2,
        ).transform,
      );
    }
  }
});

test("attached content fits the work area, chooses roomier side and preserves DSG anchor", () => {
  const area = { x: -1440, y: 30, width: 1440, height: 870 };
  for (const anchor of [
    { x: -400, y: 470 },
    { x: -1400, y: 60 },
    { x: -800, y: 300 },
    { x: -300, y: 500 },
  ]) {
    for (const section of ["chat", "expressions", "settings"]) {
      const { bounds, surface } = desktopLayout(anchor, area, section);
      assert.equal(bounds.x + surface.pet.x, anchor.x);
      assert.equal(bounds.y + surface.pet.y, anchor.y);
      assert.ok(bounds.x >= area.x && bounds.y >= area.y);
      assert.ok(bounds.x + bounds.width <= area.x + area.width);
      assert.ok(bounds.y + bounds.height <= area.y + area.height);
      const closed = desktopLayout(
        { x: bounds.x + surface.pet.x, y: bounds.y + surface.pet.y },
        area,
      );
      assert.deepEqual(closed.bounds, bounds);
      assert.deepEqual(closed.surface.pet, surface.pet);
      assert.equal(closed.surface.section, null);
    }
  }
  assert.equal(
    desktopLayout({ x: -400, y: 400 }, area, "chat").surface.side,
    "left",
  );
  assert.equal(
    desktopLayout({ x: -1400, y: 60 }, area, "chat").surface.side,
    "right",
  );
});

test("offscreen saved position and constrained screens stay reachable", () => {
  const area = { x: 0, y: 24, width: 800, height: 576 };
  for (const section of [null, "chat"]) {
    const { bounds } = desktopLayout({ x: 9000, y: -9000 }, area, section);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
  }
});

test("size settings normalize old/invalid config and resize around the feet", () => {
  for (const value of [undefined, null, "150", NaN, Infinity])
    assert.equal(normalizePetScale(value), 100);
  assert.equal(normalizePetScale(0), 50);
  assert.equal(normalizePetScale(200), 150);
  assert.equal(normalizePetScale(122), 120);
  assert.deepEqual(petSize(), PET_SIZE);
  const origin = { x: 600, y: 300 };
  for (let scale = 50; scale <= 150; scale += 5) {
    const size = petSize(scale),
      anchor = resizedPetAnchor(origin, 100, scale);
    assert.equal(anchor.x + size.width / 2, origin.x + PET_SIZE.width / 2);
    assert.equal(anchor.y + size.height, origin.y + PET_SIZE.height);
    assert.ok(size.width >= 300, "small characters retain usable controls");
    assert.deepEqual(resizedPetAnchor(anchor, scale, 100), origin);
  }
});

test("conversation presets retain the small default, preserve the pet and fit constrained displays", () => {
  for (const value of [undefined, null, "invalid", "constructor", {}, 1])
    assert.equal(normalizeChatSize(value), "small");
  const area = { x: -1920, y: 24, width: 1920, height: 1056 };
  const anchor = { x: -500, y: 500 };
  assert.deepEqual(
    desktopLayout(anchor, area, "chat"),
    desktopLayout(anchor, area, "chat", 100, "small"),
  );
  for (const [size, expected] of Object.entries(CHAT_SIZES)) {
    assert.equal(normalizeChatSize(size), size);
    const { bounds, surface } = desktopLayout(anchor, area, "chat", 100, size);
    assert.equal(surface.contentWidth, expected.width);
    assert.equal(surface.contentHeight, expected.height);
    assert.equal(bounds.x + surface.pet.x, anchor.x);
    assert.equal(bounds.y + surface.pet.y, anchor.y);
    assert.deepEqual(
      desktopLayout(anchor, area, "settings", 100, size),
      desktopLayout(anchor, area, "settings"),
    );
    for (const scale of [50, 100, 150]) {
      for (const workArea of [
        { x: 0, y: 24, width: 800, height: 576 },
        { x: -1440, y: 30, width: 1440, height: 870 },
      ]) {
        for (const position of [
          { x: -1400, y: 60 },
          { x: 9000, y: -9000 },
        ]) {
          const layout = desktopLayout(position, workArea, "chat", scale, size);
          assert.ok(layout.bounds.x >= workArea.x);
          assert.ok(layout.bounds.y >= workArea.y);
          assert.ok(
            layout.bounds.x + layout.bounds.width <=
              workArea.x + workArea.width,
          );
          assert.ok(
            layout.bounds.y + layout.bounds.height <=
              workArea.y + workArea.height,
          );
          assert.ok(layout.surface.contentWidth <= expected.width);
          assert.ok(layout.surface.contentHeight <= expected.height);
          assert.ok(layout.surface.contentWidth > 0);
        }
      }
    }
  }
});

test("scaled characters and attached content stay inside each display and preserve their anchors", () => {
  const area = { x: -1600, y: 24, width: 1600, height: 976 };
  for (const scale of [50, 75, 100, 125, 150])
    for (const section of [null, "chat", "settings"]) {
      for (const anchor of [
        { x: -1500, y: 100 },
        { x: -600, y: 450 },
        { x: 3000, y: 4000 },
      ]) {
        const { bounds, surface } = desktopLayout(anchor, area, section, scale),
          size = petSize(scale);
        assert.ok(
          bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width,
        );
        assert.ok(
          bounds.y >= area.y &&
            bounds.y + bounds.height <= area.y + area.height,
        );
        assert.ok(surface.contentTop >= 0);
        assert.ok(surface.contentTop + surface.contentHeight <= bounds.height);
        assert.ok(
          surface.pet.x >= 0 && surface.pet.x + size.width <= bounds.width,
        );
        assert.ok(
          surface.pet.y >= 0 && surface.pet.y + size.height <= bounds.height,
        );
        const closed = desktopLayout(
          { x: bounds.x + surface.pet.x, y: bounds.y + surface.pet.y },
          area,
          null,
          scale,
        );
        assert.deepEqual(closed.bounds, bounds);
        assert.deepEqual(closed.surface.pet, surface.pet);
      }
    }
});

test("all panel sizes share a native frame and pet position before their first opening", () => {
  for (const area of [
    { x: 0, y: 24, width: 1024, height: 744 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ]) {
    for (const scale of [50, 100, 150]) {
      const size = petSize(scale);
      for (const horizontal of [0, 0.5, 1]) {
        for (const vertical of [0, 0.5, 1]) {
          const anchor = {
            x: Math.round(area.x + (area.width - size.width) * horizontal),
            y: Math.round(area.y + (area.height - size.height) * vertical),
          };
          const closed = desktopLayout(anchor, area, null, scale);
          for (const section of ["chat", "settings", "expressions"]) {
            for (const chatSize of Object.keys(CHAT_SIZES)) {
              const layout = desktopLayout(
                anchor,
                area,
                section,
                scale,
                chatSize,
              );
              assert.deepEqual(layout.bounds, closed.bounds);
              assert.deepEqual(layout.surface.pet, closed.surface.pet);
              assert.equal(layout.bounds.x + layout.surface.pet.x, anchor.x);
              assert.equal(layout.bounds.y + layout.surface.pet.y, anchor.y);
            }
          }
        }
      }
    }
  }
});
