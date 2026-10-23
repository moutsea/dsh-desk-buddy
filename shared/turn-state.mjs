import { endStatus } from "./activity.mjs";

// The same identity is used for live events and read-only history snapshots.
// DSH events without an explicit turn use the persisted start sequence number.
export function turnState(event, previous) {
  const start = event?.type === "turn/start";
  const end = event?.type === "turn/end";
  const key =
    event?.data?.turn !== undefined
      ? JSON.stringify(event.data.turn)
      : start && Number.isSafeInteger(event.seq)
        ? `seq:${event.seq}`
        : previous?.key;
  if (key === undefined) return previous;
  if (!start && !end && key === previous?.key) return previous;
  const startedAt = Number.isFinite(event?.data?.startedAt)
    ? event.data.startedAt
    : key === previous?.key
      ? previous.startedAt
      : undefined;
  return {
    key,
    ...(startedAt === undefined ? {} : { startedAt }),
    status: start
      ? "thinking"
      : end
        ? endStatus(event.data?.reason)
        : undefined,
  };
}

export function latestTurn(records = []) {
  return records
    .map((record) => record.event || record)
    .filter((event) => Number.isSafeInteger(event?.seq))
    .sort((a, b) => a.seq - b.seq)
    .reduce((turn, event) => turnState(event, turn), undefined);
}
