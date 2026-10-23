// The generated app-server schema defines turn IDs as UUIDv7 and startedAt
// as a nullable Unix timestamp in seconds. Never order opaque legacy IDs or
// use thread.updatedAt / the local clock: a rollback changes those too.
function uuidTime(id) {
  return typeof id === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)
    ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    : undefined;
}

export function compareCodexTurns(current, previous) {
  if (!current || !previous) return undefined;
  if (current.id === previous.id) return 0;
  const a = uuidTime(current.id),
    b = uuidTime(previous.id);
  if (a !== undefined && b !== undefined && a !== b) return Math.sign(a - b);
  if (
    Number.isFinite(current.startedAt) &&
    current.startedAt >= 0 &&
    Number.isFinite(previous.startedAt) &&
    previous.startedAt >= 0 &&
    current.startedAt !== previous.startedAt
  )
    return Math.sign(current.startedAt - previous.startedAt);
  // Equal timestamps cannot distinguish fast turns; use history order instead.
  return undefined;
}
