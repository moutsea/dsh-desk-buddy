// DSH's tokenUsage projection contains disjoint, cumulative buckets.
// Use the projection, not loaded messages: history may be paginated/compacted.
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const sum = (...values) =>
  values.every((value) => value !== null)
    ? count(values.reduce((total, value) => total + value, 0))
    : null;
const ratio = (numerator, denominator) =>
  duration(
    numerator !== null && denominator !== null && denominator > 0
      ? numerator / denominator
      : null,
  );

/** @param {Record<string, any> | undefined} values */
export function sessionUsage(values) {
  const tokens = values?.tokenUsage;
  const uncachedInput = count(tokens?.uncachedInputTokens);
  const cacheRead = count(tokens?.cacheReadTokens);
  const cacheWrite = count(tokens?.cacheWriteTokens);
  const output = count(tokens?.outputTokens);
  const input = sum(uncachedInput, cacheRead, cacheWrite);
  const context = values?.contextPressure;
  const projected = count(context?.projectedTokens);
  const contextTokens = projected ?? count(context?.pressureTokens);
  const contextWindow = count(context?.contextWindow);
  const stats = values?.sessionStats;
  const decodeRate = ratio(
    duration(stats?.decodeTokens),
    duration(stats?.decodeMs),
  );
  const firstTokenMs = ratio(duration(stats?.ttftMs), count(stats?.ttftSteps));
  return {
    total: sum(input, output),
    input,
    output,
    uncachedInput,
    cacheRead,
    cacheWrite,
    cacheHitRate: ratio(cacheRead, input),
    contextTokens,
    contextWindow:
      contextWindow !== null && contextWindow > 0 ? contextWindow : null,
    contextEstimated: projected !== null,
    contextRate: ratio(contextTokens, contextWindow),
    tokensPerSecond: decodeRate === null ? null : duration(decodeRate * 1000),
    firstTokenSeconds: firstTokenMs === null ? null : firstTokenMs / 1000,
    turns: count(stats?.turns),
    steps: count(stats?.steps),
  };
}

export function formatTokens(value, compact = false) {
  if (value === null) return "—";
  if (compact && value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1)}M`;
  if (compact && value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}

export function formatRate(value) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
