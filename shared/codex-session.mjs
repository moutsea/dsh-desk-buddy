const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

export function codexUsage(usage) {
  const total = usage?.total;
  const input = count(total?.inputTokens);
  const cached = count(total?.cachedInputTokens);
  const write = count(total?.cacheWriteInputTokens ?? 0);
  return {
    tokenUsage: {
      uncachedInputTokens:
        input !== null && cached !== null && write !== null
          ? count(input - cached - write)
          : null,
      cacheReadTokens: cached,
      cacheWriteTokens: write,
      // Reasoning output is already included in outputTokens.
      outputTokens: count(total?.outputTokens),
    },
    contextPressure: {
      pressureTokens: count(usage?.last?.totalTokens),
      contextWindow: count(usage?.modelContextWindow),
    },
  };
}

export function codexTool(item) {
  if (item.type === "commandExecution")
    return {
      name: "bash",
      arguments: { command: item.command, cwd: item.cwd },
    };
  if (item.type === "fileChange")
    return {
      name: "apply_patch",
      arguments: {
        paths: item.changes?.map((c) => c.path),
        changes: item.changes,
      },
    };
  if (item.type === "mcpToolCall")
    return { name: `${item.server}.${item.tool}`, arguments: item.arguments };
  if (item.type === "webSearch")
    return {
      name: "web_search",
      arguments: item.action || { query: item.query },
    };
  if (item.type === "dynamicToolCall")
    return { name: item.tool, arguments: item.arguments };
  return null;
}

export function itemEvents(item, turn) {
  const data = { turn, step: item.id };
  if (item.type === "userMessage")
    return [
      {
        type: "user/message",
        data: { ...data, content: item.content, source: { kind: "user" } },
      },
    ];
  if (item.type === "agentMessage" && item.text)
    return [
      {
        type: "assistant/message",
        data: {
          ...data,
          message: { content: [{ type: "text", text: item.text }] },
        },
      },
    ];
  const tool = codexTool(item);
  if (!tool) return [];
  const events = [
    { type: "tool/call", data: { ...data, ...tool, callId: item.id } },
  ];
  if (item.status && item.status !== "inProgress")
    events.push({
      type: "tool/result",
      data: {
        ...data,
        message: {
          content: [
            {
              type: "tool-result",
              toolCallId: item.id,
              isError:
                item.status === "failed" ||
                (typeof item.exitCode === "number" && item.exitCode !== 0),
            },
          ],
        },
      },
    });
  return events;
}

// History has its own ordered snapshot, separate from the live activity clock.
// This avoids inventing durable Codex sequence numbers or replaying sounds when
// older pages are prepended. Concurrent notifications win over stale reads.
export class CodexSession {
  turns = new Map();
  order = [];
  revision = 0;
  historyEpoch = 0;
  historyRevision = 0;
  historyHead = undefined;
  currentTurnRevision = 0;
  currentTurnId = undefined;
  cursor = undefined;
  values = {};
  constructor(thread) {
    this.thread = thread;
  }
  resetHistory() {
    this.historyEpoch++;
    this.turns.clear();
    this.order = [];
    this.cursor = undefined;
    this.historyHead = undefined;
    this.historyRevision = ++this.revision;
    this.observeCurrentTurn(undefined, this.revision);
  }
  observeCurrentTurn(turn, revision) {
    if (revision < this.currentTurnRevision) return;
    this.currentTurnRevision = revision;
    this.currentTurnId = turn?.status === "inProgress" ? turn.id : undefined;
  }
  updateTurn(turn, live = false) {
    const revision = live ? ++this.revision : 0;
    let row = this.turns.get(turn.id);
    if (!row) {
      row = {
        ...turn,
        items: new Map(),
        revision,
        liveCreatedRevision: revision,
      };
      this.turns.set(turn.id, row);
      this.order.push(turn.id);
    }
    Object.assign(row, { ...turn, items: row.items });
    if (live) {
      row.revision = revision;
      this.observeCurrentTurn(row, revision);
    }
    for (const item of turn.items || []) this.updateItem(turn.id, item, live);
    return row;
  }
  updateItem(turnId, item, live = true) {
    const turn =
      this.turns.get(turnId) ||
      this.updateTurn({ id: turnId, status: "inProgress", items: [] }, live);
    const previous = turn.items.get(item.id);
    turn.items.set(item.id, {
      ...previous,
      ...item,
      revision: live ? ++this.revision : previous?.revision || 0,
    });
  }
  mergePage(turns, revision, older = false, complete = false) {
    this.revision = Math.max(this.revision, revision);
    if (!older) this.observeCurrentTurn(turns.at(-1), revision);
    const ids = turns.map((turn) => turn.id);
    // External/read-only threads do not deliver revert notifications. Once a
    // recent read reaches the beginning, missing old turns are no longer part
    // of the history. Keep any work received live after this read began.
    if (complete && !older) {
      const present = new Set(ids);
      this.order = this.order.filter((id) => {
        const row = this.turns.get(id);
        if (
          present.has(id) ||
          row.revision > revision ||
          [...row.items.values()].some((item) => item.revision > revision)
        )
          return true;
        this.turns.delete(id);
        return false;
      });
    }
    const previousOrder = [...this.order];
    for (const turn of turns) {
      const row =
        this.turns.get(turn.id) || this.updateTurn({ ...turn, items: [] });
      if (row.revision <= revision)
        Object.assign(row, { ...turn, items: row.items, revision });
      const items = new Map();
      for (const item of turn.items || []) {
        const current = row.items.get(item.id);
        items.set(
          item.id,
          current?.revision > revision ? current : { ...item, revision },
        );
      }
      for (const [id, item] of row.items)
        if (!items.has(id)) items.set(id, item);
      row.items = items;
    }
    // Place the page relative to the order before inserting missing turns. With
    // no overlap, only turns first seen live after the read belong behind it.
    const others = previousOrder.filter((id) => !ids.includes(id));
    const first = previousOrder.findIndex((id) => ids.includes(id));
    const after = older
      ? others
      : others.filter((id) =>
          first >= 0
            ? previousOrder.indexOf(id) > first
            : this.turns.get(id).liveCreatedRevision > revision,
        );
    const before = older ? [] : others.filter((id) => !after.includes(id));
    this.order = [...before, ...ids, ...after];
  }
  events(streamingItemId) {
    const result = [];
    for (const id of this.order) {
      const turn = this.turns.get(id);
      result.push({
        type: "turn/start",
        data: {
          turn: id,
          ...(Number.isFinite(turn.startedAt)
            ? { startedAt: turn.startedAt }
            : {}),
        },
      });
      for (const item of turn.items.values())
        if (item.id !== streamingItemId) result.push(...itemEvents(item, id));
      if (turn.status !== "inProgress")
        result.push({
          type: "turn/end",
          data: { turn: id, reason: { kind: turn.status, error: turn.error } },
        });
    }
    return result.map((event, seq) => ({ ...event, seq }));
  }
  get activeTurn() {
    return [...this.order]
      .reverse()
      .map((id) => this.turns.get(id))
      .find((turn) => turn.status === "inProgress")?.id;
  }
}
