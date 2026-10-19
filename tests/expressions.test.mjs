import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EXPRESSIONS,
  chooseExpression,
  expressionForMood,
} from "../shared/expressions.mjs";

test("active task states override idle reactions and random expressions", () => {
  const options = {
    now: 100,
    idleExpression: "rice",
    interaction: { id: "love", until: 500 },
  };
  assert.equal(chooseExpression({ ...options, taskMood: "tool" }), "working");
  assert.equal(
    chooseExpression({ ...options, taskMood: "waiting" }),
    "confused",
  );
  assert.equal(
    chooseExpression({ ...options, taskMood: "error" }),
    "surprised",
  );
  assert.equal(
    chooseExpression({ ...options, taskMood: "learning" }),
    "learning",
  );
  assert.equal(
    chooseExpression({ ...options, taskMood: "celebrating" }),
    "celebrating",
  );
  assert.equal(
    chooseExpression({ ...options, taskMood: "offline" }),
    "sleeping",
  );
  assert.equal(chooseExpression({ ...options, taskMood: "idle" }), "love");
  assert.equal(
    chooseExpression({ ...options, taskMood: "idle", now: 501 }),
    "rice",
  );
  assert.equal(
    chooseExpression({ ...options, taskMood: "done", now: 501 }),
    "happy",
  );
});
test("manual expressions remain pinned across task changes and unknown selections recover", () => {
  for (const taskMood of ["idle", "tool", "waiting", "error", "offline"])
    assert.equal(chooseExpression({ taskMood, selection: "proud" }), "proud");
  assert.equal(
    chooseExpression({ selection: "removed-skin", taskMood: "tool" }),
    "working",
  );
  assert.equal(expressionForMood("__proto__"), "idle");
  assert.equal(chooseExpression({ idleExpression: "missing-image" }), "idle");
});
test("every selectable expression ships as a matching full-size transparent PNG", async () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(EXPRESSIONS.length, 19);
  assert.equal(new Set(EXPRESSIONS.map((item) => item.id)).size, 19);
  for (const item of EXPRESSIONS) {
    const file = await readFile(
      new URL(
        `../public/characters/deepseek-girl/${item.id}.png`,
        import.meta.url,
      ),
    );
    assert.deepEqual(file.subarray(0, 8), signature, `${item.id}: valid PNG`);
    assert.ok(
      Math.abs(file.readUInt32BE(16) - 1145) <= 2,
      `${item.id}: consistent width`,
    );
    assert.ok(
      Math.abs(file.readUInt32BE(20) - 1374) <= 2,
      `${item.id}: consistent height`,
    );
    assert.equal(file[25], 6, `${item.id}: RGBA`);
  }
});
