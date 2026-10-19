import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EXPRESSIONS } from "../shared/expressions.mjs";
import {
  MOTIONS,
  motionDuration,
  motionKeyframes,
} from "../shared/motions.mjs";

test("all expressions have a complete four-frame loop and discrete, seamless playback", () => {
  assert.deepEqual(
    Object.keys(MOTIONS).sort(),
    EXPRESSIONS.map((e) => e.id).sort(),
  );
  for (const { id } of EXPRESSIONS) {
    const sequence = MOTIONS[id].sequence;
    assert.deepEqual(
      [...new Set(sequence.map(([index]) => index))].sort(),
      [0, 1, 2, 3],
      id,
    );
    assert.ok(
      sequence.every(([, duration]) => duration >= 100),
      `${id}: visible holds`,
    );
    const frames = motionKeyframes(id, 1200, 1440);
    assert.equal(frames[0].offset, 0);
    assert.equal(frames.at(-1).offset, 1);
    assert.equal(
      frames.at(-1).transform,
      frames[0].transform,
      `${id}: closes loop`,
    );
    assert.ok(
      frames.every(
        (frame, i) =>
          frame.easing === "steps(1, end)" &&
          (!i || frame.offset > frames[i - 1].offset),
      ),
    );
    assert.equal(
      motionDuration(id),
      sequence.reduce((sum, [, ms]) => sum + ms, 0),
    );
  }
  assert.deepEqual(motionKeyframes("unknown", 100, 100), []);
  assert.deepEqual(motionKeyframes("idle", 0, 100), []);
});

test("every animation ships a full-size transparent 2×2 sprite sheet", async () => {
  const registration = JSON.parse(
    await readFile(
      new URL(
        "../public/characters/deepseek-girl/animations/registration.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const { id } of EXPRESSIONS) {
    const png = await readFile(
      new URL(
        `../public/characters/deepseek-girl/animations/${id}.png`,
        import.meta.url,
      ),
    );
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    assert.ok(
      width >= 1000 && height >= 1200,
      `${id}: enough resolution for retina desktop`,
    );
    assert.ok(
      width / height > 0.75 && width / height < 0.9,
      `${id}: portrait cells`,
    );
    assert.equal(png[25], 6, `${id}: native RGBA`);
    const entry = registration[id];
    assert.equal(entry.width, width, `${id}: crop metadata matches source`);
    assert.equal(entry.height, height);
    assert.equal(entry.frames.length, 4);
    for (const [index, box] of entry.frames.entries()) {
      const x = ((index % 2) * width) / 2,
        y = (Math.floor(index / 2) * height) / 2;
      assert.ok(
        x + box.left >= 0 && x + box.right <= width && box.left < box.right,
      );
      assert.ok(
        y + box.top >= 0 && y + box.bottom <= height && box.top < box.bottom,
      );
      assert.ok(Number.isFinite(box.dx) && Number.isFinite(box.dy));
      assert.ok(box.outline.length >= 3);
      for (const [px, py] of box.outline) {
        assert.ok(
          x + px >= 0 && x + px <= width && y + py >= 0 && y + py <= height,
        );
      }
    }
  }
});
