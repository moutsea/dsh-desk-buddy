import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRate,
  formatTokens,
  sessionUsage,
} from "../shared/session-usage.mjs";

const tokens = {
  uncachedInputTokens: 1000,
  cacheReadTokens: 8000,
  cacheWriteTokens: 1000,
  outputTokens: 2000,
};

test("usage uses disjoint DSH buckets and prompt-only cache denominator", () => {
  const usage = sessionUsage({
    tokenUsage: { ...tokens, reasoningTokens: 500 },
  });
  assert.equal(usage.input, 10000);
  assert.equal(usage.total, 12000);
  assert.equal(usage.output, 2000, "reasoning is already included in output");
  assert.equal(usage.cacheHitRate, 0.8);
});

test("missing and partial usage is unknown, while reported zero remains zero", () => {
  const empty = sessionUsage();
  assert.equal(empty.total, null);
  assert.equal(empty.cacheHitRate, null);
  assert.equal(empty.contextRate, null);
  assert.equal(empty.tokensPerSecond, null);
  assert.equal(empty.firstTokenSeconds, null);
  assert.equal(empty.turns, null);
  const partial = sessionUsage({ tokenUsage: { outputTokens: 15 } });
  assert.equal(partial.output, 15);
  assert.equal(partial.total, null);
  const zero = sessionUsage({
    tokenUsage: Object.fromEntries(Object.keys(tokens).map((key) => [key, 0])),
    sessionStats: {
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
      turns: 0,
      steps: 0,
    },
  });
  assert.equal(zero.total, 0);
  assert.equal(zero.cacheHitRate, null, "0 / 0 has no rate");
  assert.equal(zero.tokensPerSecond, null);
  assert.equal(zero.firstTokenSeconds, null);
  assert.equal(zero.turns, 0);
  assert.equal(
    sessionUsage({ tokenUsage: { ...tokens, cacheReadTokens: 0 } })
      .cacheHitRate,
    0,
  );
});

test("context uses next-request estimate, independently of cumulative token usage", () => {
  const values = {
    tokenUsage: tokens,
    contextPressure: {
      projectedTokens: 2500,
      pressureTokens: 2000,
      contextWindow: 10000,
    },
  };
  const usage = sessionUsage(values);
  assert.equal(usage.contextRate, 0.25);
  assert.equal(usage.contextEstimated, true);
  assert.equal(usage.total, 12000);
  assert.equal(
    sessionUsage({
      contextPressure: { ...values.contextPressure, projectedTokens: 0 },
    }).contextRate,
    0,
  );
  const reported = sessionUsage({
    contextPressure: { pressureTokens: 12000, contextWindow: 10000 },
  });
  assert.equal(
    reported.contextRate,
    1.2,
    "over-capacity is not hidden by clamping",
  );
  assert.equal(reported.contextEstimated, false);
  assert.equal(
    sessionUsage({ contextPressure: { projectedTokens: 10 } }).contextRate,
    null,
  );
  assert.equal(
    sessionUsage({ contextPressure: { projectedTokens: 10, contextWindow: 0 } })
      .contextWindow,
    null,
  );
});

test("speed and TTFT are weighted by their actual measured samples", () => {
  const usage = sessionUsage({
    tokenUsage: tokens,
    sessionStats: {
      turns: 2,
      steps: 4,
      decodeMs: 5000,
      decodeTokens: 500,
      ttftMs: 600,
      ttftSteps: 3,
    },
  });
  assert.equal(usage.tokensPerSecond, 100);
  assert.equal(usage.firstTokenSeconds, 0.2);
  assert.equal(usage.turns, 2);
  assert.equal(usage.steps, 4);
});

test("malformed values never become plausible zero totals or NaN/Infinity rates", () => {
  for (const bad of [
    undefined,
    null,
    "10",
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const usage = sessionUsage({
      tokenUsage: { ...tokens, cacheReadTokens: bad },
    });
    assert.equal(usage.total, null);
    assert.equal(usage.cacheHitRate, null);
  }
  assert.equal(
    sessionUsage({
      tokenUsage: { ...tokens, outputTokens: Number.MAX_SAFE_INTEGER },
    }).total,
    null,
  );
  assert.equal(
    sessionUsage({
      sessionStats: { decodeTokens: Number.MAX_VALUE, decodeMs: 0.001 },
    }).tokensPerSecond,
    null,
  );
  assert.equal(
    sessionUsage({ sessionStats: { ttftMs: -50, ttftSteps: 1 } })
      .firstTokenSeconds,
    null,
  );
});

test("compact values, exact counts and missing rates are readable", () => {
  assert.equal(formatTokens(12345, true), "12.3k");
  assert.equal(formatTokens(1234567, true), "1.2M");
  assert.equal(formatTokens(12345), "12,345");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(0), "0.0%");
  assert.equal(formatRate(0.81234), "81.2%");
});
