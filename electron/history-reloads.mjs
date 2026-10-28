// A history reset stays pending until a current read commits. Tickets belong
// to one invalidation, so stale reads cannot clear a newer reset or its error.
export class HistoryReloads {
  entries = new Map();
  invalidate(id, afterSeq) {
    // Repeated disconnects must keep the original gap boundary, even if live
    // events have since advanced the displayed tail. An explicit history reset
    // omits the boundary and replaces it together with the old history.
    this.entries.set(id, {
      active: 0,
      error: "",
      afterSeq:
        afterSeq === undefined
          ? undefined
          : (this.entries.get(id)?.afterSeq ?? afterSeq),
    });
  }
  begin(id) {
    const ticket = this.entries.get(id);
    if (ticket) ticket.active++;
    return ticket;
  }
  finish(id, ticket, { success = false, error = "" } = {}) {
    if (!ticket) return;
    ticket.active--;
    if (this.entries.get(id) !== ticket) return;
    if (success) this.entries.delete(id);
    else if (error) ticket.error = error;
  }
  needsRetry(id) {
    return this.entries.get(id)?.active === 0;
  }
  snapshot(id) {
    const entry = this.entries.get(id);
    return entry
      ? { error: entry.error, retainsHistory: entry.afterSeq !== undefined }
      : null;
  }
  forget(matches) {
    for (const id of this.entries.keys())
      if (matches(id)) this.entries.delete(id);
  }
}
