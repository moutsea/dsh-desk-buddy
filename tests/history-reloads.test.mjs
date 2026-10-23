import test from "node:test";
import assert from "node:assert/strict";
import { HistoryReloads } from "../electron/history-reloads.mjs";

test("failed reset reads remain retryable until a successful current read commits", () => {
  const reloads = new HistoryReloads();
  reloads.invalidate("codex:a");
  const first = reloads.begin("codex:a");
  assert.equal(reloads.needsRetry("codex:a"), false);
  reloads.finish("codex:a", first, { error: "temporary failure" });
  assert.deepEqual(reloads.snapshot("codex:a"), { error: "temporary failure" });
  assert.equal(reloads.needsRetry("codex:a"), true);
  const retry = reloads.begin("codex:a");
  reloads.finish("codex:a", retry, { success: true });
  assert.equal(reloads.needsRetry("codex:a"), false);
  assert.equal(reloads.snapshot("codex:a"), null);
});

test("an old read cannot clear a new reset or publish its error into it", () => {
  for (const result of [{ success: true }, { error: "stale failure" }]) {
    const reloads = new HistoryReloads();
    reloads.invalidate("codex:a");
    const stale = reloads.begin("codex:a");
    reloads.invalidate("codex:a");
    reloads.finish("codex:a", stale, result);
    assert.deepEqual(reloads.snapshot("codex:a"), { error: "" });
    assert.equal(reloads.needsRetry("codex:a"), true);
  }
});

test("overlapping reads suppress retries and late failures cannot undo success", () => {
  const reloads = new HistoryReloads();
  reloads.invalidate("codex:a");
  const first = reloads.begin("codex:a"),
    second = reloads.begin("codex:a");
  reloads.finish("codex:a", first, { error: "temporary failure" });
  assert.equal(reloads.needsRetry("codex:a"), false);
  reloads.finish("codex:a", second, { success: true });
  assert.equal(reloads.snapshot("codex:a"), null);
  reloads.invalidate("codex:a");
  const old = reloads.begin("codex:a"),
    fresh = reloads.begin("codex:a");
  reloads.finish("codex:a", fresh, { success: true });
  reloads.finish("codex:a", old, { error: "late failure" });
  assert.equal(reloads.snapshot("codex:a"), null);
});

test("navigation and provider cleanup keep reloads isolated", () => {
  const reloads = new HistoryReloads();
  for (const id of ["codex:a", "codex:b", "dsh-session"])
    reloads.invalidate(id);
  const reading = reloads.begin("codex:a");
  // A response discarded after navigation is not a committed reload.
  reloads.finish("codex:a", reading);
  assert.equal(reloads.needsRetry("codex:a"), true);
  reloads.forget((id) => id.startsWith("codex:"));
  assert.equal(reloads.snapshot("codex:a"), null);
  assert.equal(reloads.snapshot("codex:b"), null);
  assert.equal(reloads.needsRetry("dsh-session"), true);
});
