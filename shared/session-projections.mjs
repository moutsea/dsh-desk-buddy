const validSeq = (seq) => Number.isSafeInteger(seq) && seq >= -1;
const validValues = (values) =>
  values !== null && typeof values === "object" && !Array.isArray(values);

// Cached list hints have no comparable sequence. Authoritative baselines and
// live replacements compete per key, not against another metric's watermark.
export class SessionProjections {
  rows = new Map();
  baselineSeq = -Infinity;
  asOfSeq = -1;
  seedRevision = 0;
  appliedSeedRevision = 0;

  // A caller can share one request clock across history and control streams,
  // including sessions whose stores did not exist when the stream opened.
  beginSeed(revision = ++this.seedRevision) {
    this.seedRevision = Math.max(this.seedRevision, revision);
    return (block) => this.seed(block, revision);
  }

  apply(key, value, seq) {
    if (typeof key !== "string" || !validSeq(seq)) return;
    const previous = this.rows.get(key);
    if (seq <= Math.max(this.baselineSeq, previous?.seq ?? -Infinity)) return;
    this.rows.set(key, { seq, value });
    this.asOfSeq = Math.max(this.asOfSeq, seq);
  }

  list(block) {
    if (!validValues(block?.values)) return;
    if (block.kind === "cached") {
      // Once a full baseline has answered, omitted keys are absent capabilities.
      if (this.baselineSeq !== -Infinity) return;
      for (const [key, value] of Object.entries(block.values))
        if (this.rows.get(key)?.seq === undefined)
          this.rows.set(key, { value });
    } else {
      // Legacy hosts omit kind; their list watermarks are session sequences.
      for (const [key, value] of Object.entries(block.values))
        this.apply(key, value, block.asOfSeq);
    }
  }

  seed(block, revision = ++this.seedRevision) {
    this.seedRevision = Math.max(this.seedRevision, revision);
    if (!validValues(block?.values) || !validSeq(block.asOfSeq)) return;
    if (
      block.asOfSeq < this.baselineSeq ||
      (block.asOfSeq === this.baselineSeq &&
        revision < this.appliedSeedRevision)
    )
      return;
    for (const [key, row] of this.rows)
      if (row.seq === undefined) this.rows.delete(key);
    for (const [key, value] of Object.entries(block.values)) {
      // A newer full snapshot can correct existing values at the same cut,
      // as well as restore capabilities. Keep any later per-key live value;
      // list hints and duplicate frames still use apply's strict seq guard.
      if ((this.rows.get(key)?.seq ?? -Infinity) <= block.asOfSeq)
        this.rows.set(key, { seq: block.asOfSeq, value });
    }
    for (const [key, row] of this.rows)
      if (!Object.hasOwn(block.values, key) && row.seq <= block.asOfSeq)
        this.rows.delete(key);
    // Retain the cut so stale hints/frames cannot resurrect omitted keys.
    // The request revision belongs to this cut: an older request can advance
    // the session sequence, so a previous cut's revision must not carry over.
    this.baselineSeq = block.asOfSeq;
    this.appliedSeedRevision = revision;
    this.asOfSeq = Math.max(this.asOfSeq, block.asOfSeq);
  }

  snapshot() {
    return {
      asOfSeq: this.asOfSeq,
      values: Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ),
    };
  }
}
