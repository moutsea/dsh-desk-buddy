import test from "node:test";
import assert from "node:assert/strict";
import { latestTurn, turnState } from "../shared/turn-state.mjs";

test("history and live turn identities agree without replaying activity", () => {
  const start = { seq: 9, type: "turn/start", data: {} };
  const end = { seq: 11, type: "turn/end", data: { reason: "completed" } };
  const running = turnState(start);
  assert.deepEqual(running, { key: "seq:9", status: "thinking" });
  assert.deepEqual(
    latestTurn([{ event: end }, { event: start }]),
    turnState(end, running),
  );
  assert.deepEqual(
    latestTurn([
      start,
      end,
      { seq: 12, type: "turn/start", data: { turn: "next" } },
      { seq: 13, type: "assistant/chunk", data: { turn: "next" } },
    ]),
    { key: '"next"', status: "thinking" },
  );
  assert.deepEqual(
    latestTurn([
      { seq: 15, type: "turn/end", data: { turn: 3, reason: "interrupted" } },
    ]),
    { key: "3", status: "cancelled" },
  );
  assert.equal(
    latestTurn([{ seq: 20, type: "assistant/chunk", data: {} }]),
    undefined,
  );
});
