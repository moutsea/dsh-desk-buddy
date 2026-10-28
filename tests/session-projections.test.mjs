import test from "node:test";
import assert from "node:assert/strict";
import { SessionProjections } from "../shared/session-projections.mjs";

test("snapshot exposes a live model revision without unrelated watermark churn", () => {
  const store = new SessionProjections();
  store.apply("modelSelection", { next: { provider: "deepseek", model: "a" } }, 10);
  store.apply("tokenUsage", { outputTokens: 3 }, 11);
  assert.equal(store.snapshot().asOfSeq, 11);
  assert.equal(store.snapshot().modelSelectionSeq, 1);
});

test("a late history snapshot never revokes or rewrites the live model revision", () => {
  const store = new SessionProjections();
  store.seed({
    asOfSeq: 10,
    values: { modelSelection: { next: { provider: "dsh", model: "a" } } },
  });
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "b" } },
    11,
  );
  const stale = store.beginSeed();
  stale({
    asOfSeq: 12,
    values: { modelSelection: { next: { provider: "dsh", model: "a" } } },
  });
  const snap = store.snapshot();
  assert.equal(snap.asOfSeq, 12);
  assert.equal(snap.modelSelectionSeq, 1);
});

test("a snapshot cut that arrives before live model events cannot swallow them", () => {
  const store = new SessionProjections();
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "a" } },
    10,
  );
  const marker = store.snapshot().modelSelectionSeq;
  store.seed({
    asOfSeq: 13,
    values: { modelSelection: { next: { provider: "dsh", model: "a" } } },
  });
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "b" } },
    11,
  );
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "a" } },
    12,
  );
  assert.equal(store.snapshot().values.modelSelection.next.model, "a");
  assert.ok(store.snapshot().modelSelectionSeq > marker);
});

test("duplicate live model events do not churn the model watermark", () => {
  const store = new SessionProjections();
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "a" } },
    10,
  );
  assert.equal(store.snapshot().modelSelectionSeq, 1);
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "a" } },
    10,
  );
  assert.equal(store.snapshot().modelSelectionSeq, 1);
  store.apply(
    "modelSelection",
    { next: { provider: "dsh", model: "b" } },
    11,
  );
  assert.equal(store.snapshot().modelSelectionSeq, 2);
});

test("cached checkpoints yield to lower-sequence authoritative history and live updates", () => {
  const store = new SessionProjections();
  store.list({
    kind: "cached",
    asOfSeq: 1000,
    values: { tokens: 120000, obsolete: true },
  });
  assert.equal(store.snapshot().values.tokens, 120000);
  store.seed({ asOfSeq: 10, values: { tokens: 12000 } });
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 10,
    values: { tokens: 12000 },
  });
  store.apply("tokens", 24000, 11);
  store.list({
    kind: "cached",
    asOfSeq: 2000,
    values: { tokens: 120000, obsolete: true },
  });
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 11,
    values: { tokens: 24000 },
  });
});

test("cached hints cannot replace live metrics before the full baseline arrives", () => {
  const store = new SessionProjections();
  store.apply("tokens", 24000, 11);
  store.list({
    kind: "cached",
    asOfSeq: 1000,
    values: { tokens: 120000, context: 25 },
  });
  assert.deepEqual(store.snapshot().values, { tokens: 24000, context: 25 });
  store.seed({ asOfSeq: 10, values: { tokens: 12000, context: 50 } });
  assert.deepEqual(store.snapshot().values, { tokens: 24000, context: 50 });
});

test("watermarks are per metric so a newer token delta cannot suppress a context delta or snapshot", () => {
  const store = new SessionProjections();
  store.apply("tokens", 24000, 20);
  store.apply("context", 50, 15);
  store.seed({ asOfSeq: 16, values: { tokens: 12000, context: 60, steps: 8 } });
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 20,
    values: { tokens: 24000, context: 60, steps: 8 },
  });
  store.apply("steps", 9, 17);
  store.apply("tokens", 0, 20);
  store.apply("context", 0, 14);
  assert.deepEqual(store.snapshot().values, {
    tokens: 24000,
    context: 60,
    steps: 9,
  });
});

test("full baselines clear missing metrics and stale hints cannot resurrect them", () => {
  const store = new SessionProjections();
  store.seed({ asOfSeq: 10, values: { tokens: 12000, context: 25 } });
  store.apply("tokens", 24000, 20);
  store.seed({ asOfSeq: 15, values: {} });
  store.seed({ asOfSeq: 12, values: { tokens: 0, context: 1 } });
  store.list({ kind: "sequenced", asOfSeq: 14, values: { context: 2 } });
  store.apply("context", 3, 15);
  assert.deepEqual(store.snapshot().values, { tokens: 24000 });
  store.apply("context", 50, 16);
  assert.deepEqual(store.snapshot().values, { tokens: 24000, context: 50 });
});

test("partial list hints retain omitted metrics, accept legacy sequences, and ignore malformed blocks", () => {
  const store = new SessionProjections();
  store.seed({ asOfSeq: 10, values: { tokens: 12000, context: 25 } });
  store.list({ kind: "sequenced", asOfSeq: 12, values: { tokens: 24000 } });
  store.list({ asOfSeq: 11, values: { tokens: 0, context: 50 } });
  for (const block of [
    undefined,
    {},
    { asOfSeq: 100, values: null },
    { asOfSeq: NaN, values: {} },
  ]) {
    store.list(block);
    store.seed(block);
  }
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 12,
    values: { tokens: 24000, context: 50 },
  });
});

test("a full snapshot restores capabilities at the same cut without weakening stale-frame or cached-hint guards", () => {
  for (const seq of [-1, 10]) {
    const store = new SessionProjections();
    store.seed({ asOfSeq: seq, values: {} });
    store.list({ kind: "cached", asOfSeq: 1000, values: { tokens: 99999 } });
    store.list({ kind: "sequenced", asOfSeq: seq, values: { tokens: 99999 } });
    store.apply("tokens", 99999, seq);
    assert.deepEqual(store.snapshot().values, {});
    store.seed({ asOfSeq: seq, values: { tokens: 12000 } });
    assert.deepEqual(store.snapshot(), {
      asOfSeq: seq,
      values: { tokens: 12000 },
    });
    store.seed({ asOfSeq: seq - 1, values: { tokens: 1, context: 1 } });
    store.apply("tokens", 1, seq);
    store.list({ kind: "cached", asOfSeq: 2000, values: { tokens: 99999 } });
    assert.deepEqual(store.snapshot().values, { tokens: 12000 });
    store.apply("tokens", 24000, seq + 2);
    store.seed({ asOfSeq: seq, values: { tokens: 12000, context: 50 } });
    assert.deepEqual(store.snapshot().values, { tokens: 24000, context: 50 });
  }
});

test("a capability removed by a full snapshot can return at that cut while older snapshots remain stale", () => {
  const store = new SessionProjections();
  store.seed({ asOfSeq: 10, values: { tokens: 12000 } });
  store.seed({ asOfSeq: 10, values: {} });
  store.seed({ asOfSeq: 9, values: { tokens: 1 } });
  assert.deepEqual(store.snapshot().values, {});
  store.seed({ asOfSeq: 10, values: { tokens: 12000 } });
  assert.deepEqual(store.snapshot().values, { tokens: 12000 });
});

test("out-of-order history snapshots cannot undo same-cut capability changes", () => {
  for (const [previous, current] of [
    [{}, { tokens: 12000 }],
    [{ tokens: 12000 }, {}],
    [{ tokens: 12000 }, { tokens: 24000 }],
    [{ tokens: 24000 }, { tokens: 12000 }],
  ]) {
    const store = new SessionProjections();
    store.seed({ asOfSeq: 10, values: previous });
    const older = store.beginSeed();
    const newer = store.beginSeed();
    newer({ asOfSeq: 10, values: current });
    older({ asOfSeq: 10, values: previous });
    assert.deepEqual(store.snapshot().values, current);
  }
});

test("new full snapshots correct existing values at the same cut, including empty sessions", () => {
  for (const seq of [-1, 10]) {
    const store = new SessionProjections();
    store.seed({ asOfSeq: seq, values: { tokens: 12000, context: null } });
    store.seed({ asOfSeq: seq, values: { tokens: 24000, context: 50 } });
    assert.deepEqual(store.snapshot().values, { tokens: 24000, context: 50 });
    store.seed({ asOfSeq: seq, values: { tokens: 0, context: 0 } });
    assert.deepEqual(store.snapshot().values, { tokens: 0, context: 0 });
    store.apply("tokens", 99999, seq);
    store.list({ kind: "sequenced", asOfSeq: seq, values: { context: 99 } });
    assert.deepEqual(store.snapshot().values, { tokens: 0, context: 0 });
  }
});

test("same-cut corrections retain higher-sequence live values and reject delayed snapshots", () => {
  const store = new SessionProjections();
  store.seed({ asOfSeq: 10, values: { tokens: 12000, context: 25 } });
  const delayed = store.beginSeed();
  store.apply("tokens", 48000, 12);
  store.seed({ asOfSeq: 10, values: { tokens: 24000, context: 50 } });
  delayed({ asOfSeq: 10, values: { tokens: 12000, context: 25 } });
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 12,
    values: { tokens: 48000, context: 50 },
  });
});

test("full snapshots correct equal-sequence list or live values before any baseline", () => {
  for (const source of ["list", "live"]) {
    const store = new SessionProjections();
    if (source === "list")
      store.list({ kind: "sequenced", asOfSeq: 10, values: { tokens: 12000 } });
    else store.apply("tokens", 12000, 10);
    store.seed({ asOfSeq: 10, values: { tokens: 24000 } });
    assert.equal(store.snapshot().values.tokens, 24000);
  }
});

test("a control baseline supersedes pending history without suppressing newer live metrics", () => {
  const store = new SessionProjections();
  const oldEmpty = store.beginSeed();
  store.seed({ asOfSeq: 10, values: { tokens: 12000 } });
  store.apply("tokens", 24000, 11);
  oldEmpty({ asOfSeq: 10, values: {} });
  assert.deepEqual(store.snapshot().values, { tokens: 24000 });

  const oldPresent = store.beginSeed();
  store.seed({ asOfSeq: 11, values: {} });
  oldPresent({ asOfSeq: 11, values: { tokens: 24000 } });
  assert.deepEqual(store.snapshot().values, {});
});

test("pending or malformed newer requests do not discard a usable older response", () => {
  const store = new SessionProjections();
  const older = store.beginSeed();
  const invalid = store.beginSeed();
  store.beginSeed(); // A request that has not answered (or fails) has no baseline.
  invalid({ asOfSeq: 10, values: null });
  older({ asOfSeq: 10, values: { tokens: 12000 } });
  assert.deepEqual(store.snapshot().values, { tokens: 12000 });
});

test("a higher session sequence takes precedence over snapshot request order", () => {
  const store = new SessionProjections();
  const older = store.beginSeed();
  const newer = store.beginSeed();
  newer({ asOfSeq: 10, values: {} });
  older({ asOfSeq: 11, values: { tokens: 24000 } });
  assert.deepEqual(store.snapshot(), {
    asOfSeq: 11,
    values: { tokens: 24000 },
  });
});

test("snapshot request order belongs to its session cut across three overlapping requests", () => {
  for (const [previous, current] of [
    [{ tokens: 24000 }, { tokens: 36000 }],
    [{ tokens: 24000 }, {}],
    [{}, { tokens: 36000 }],
  ]) {
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const store = new SessionProjections();
      const requests = [
        store.beginSeed(),
        store.beginSeed(),
        store.beginSeed(),
      ];
      const responses = [
        { asOfSeq: 11, values: previous },
        { asOfSeq: 11, values: current },
        { asOfSeq: 10, values: { tokens: 12000 } },
      ];
      for (const index of order) requests[index](responses[index]);
      assert.deepEqual(
        store.snapshot(),
        { asOfSeq: 11, values: current },
        `response order: ${order.join(",")}`,
      );
      // Neither an older request at this cut nor a later request at an older
      // cut may undo the accepted correction or capability change.
      requests[0](responses[0]);
      requests[2](responses[2]);
      assert.deepEqual(store.snapshot().values, current);
    }
  }
});

test("advancing a baseline's cut preserves higher live values during later corrections and removals", () => {
  for (const current of [{ context: 75 }, {}]) {
    const store = new SessionProjections();
    const first = store.beginSeed();
    const second = store.beginSeed();
    const third = store.beginSeed();
    third({ asOfSeq: 10, values: { tokens: 12000, context: 25 } });
    first({ asOfSeq: 11, values: { tokens: 24000, context: 50 } });
    store.apply("tokens", 48000, 12);
    second({ asOfSeq: 11, values: current });
    assert.deepEqual(store.snapshot(), {
      asOfSeq: 12,
      values: { tokens: 48000, ...current },
    });
  }
});

test("control subscription order is shared with history, even for stores created later", () => {
  for (const [oldValues, newValues] of [
    [{}, { tokens: 12000 }],
    [{ tokens: 12000 }, {}],
    [{ tokens: 12000 }, { tokens: 24000 }],
    [{ tokens: 24000 }, { tokens: 12000 }],
  ]) {
    const controlRevision = 10; // Reserved before either session store exists.
    const first = new SessionProjections();
    const second = new SessionProjections();
    first.beginSeed(11)({ asOfSeq: 20, values: newValues });
    second.beginSeed(12)({ asOfSeq: 20, values: newValues });
    for (const store of [first, second]) {
      store.seed({ asOfSeq: 20, values: oldValues }, controlRevision);
      assert.deepEqual(store.snapshot().values, newValues);
      // Subsequent local requests must also follow the shared request clock.
      store.beginSeed()({ asOfSeq: 20, values: oldValues });
      assert.deepEqual(store.snapshot().values, oldValues);
    }
  }
});

test("new control subscriptions supersede older history while higher cursors still win", () => {
  const store = new SessionProjections();
  const olderHistory = store.beginSeed(20);
  store.seed({ asOfSeq: 10, values: { tokens: 12000 } }, 21);
  olderHistory({ asOfSeq: 10, values: {} });
  assert.deepEqual(store.snapshot().values, { tokens: 12000 });
  store.beginSeed(23)({ asOfSeq: 10, values: {} });
  store.seed({ asOfSeq: 11, values: { tokens: 24000 } }, 22);
  assert.deepEqual(store.snapshot().values, { tokens: 24000 });
});
