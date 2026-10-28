import type { SourceRun } from "./markdown-source";

export type HistoryAnchor = {
  id: string;
  offset: number;
  text?: { part: string; index: number; offset: number };
};
type TextAnchor = { id: string; start: number; end: number };

function textAnchors(message: HTMLElement): TextAnchor[] {
  return JSON.parse(message.dataset.messageTextAnchors || "[]");
}

function sourceRuns(span: HTMLElement): SourceRun[] {
  return span.dataset.sourceRuns
    ? JSON.parse(span.dataset.sourceRuns)
    : [[0, Number(span.dataset.sourceStart)]];
}

function characterRect(node: Text, index: number) {
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range.getBoundingClientRect();
}

function captureTextAnchor(message: HTMLElement, top: number) {
  for (const span of message.querySelectorAll<HTMLElement>(
    "[data-source-start]",
  )) {
    const node = span.firstChild;
    if (!(node instanceof Text) || !node.data.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (!box.height || box.bottom <= top) continue;
    let low = 0,
      high = node.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (characterRect(node, mid).bottom > top) high = mid;
      else low = mid + 1;
    }
    const run = sourceRuns(span)
      .filter(([index]) => index <= low)
      .at(-1)!;
    const source = run[1] + low - run[0];
    // Partial replies still belong to their chunks after interruption or a
    // canonical rewrite that invalidated the first delta's source range.
    // Final IDs survive snapshots that omit the chunks.
    const parts = textAnchors(message);
    const part =
      message.dataset.messagePartial === "true"
        ? parts.find((item) => item.start <= source && source < item.end)
        : undefined;
    return {
      part: part?.id || message.dataset.messageId!,
      index: source - (part?.start || 0),
      offset: characterRect(node, low).top - top,
    };
  }
}

function restoredTextTop(message: HTMLElement, anchor: HistoryAnchor) {
  if (!anchor.text) return;
  const part = textAnchors(message).find(
    (item) => item.id === anchor.text!.part,
  );
  if (anchor.text.part !== message.dataset.messageId && !part) return;
  const target = (part?.start || 0) + anchor.text.index;
  if (part && target >= part.end) return;
  // Use parser source offsets, not rendered-body matching: closing Markdown
  // delimiters or an identical earlier paragraph cannot redirect this anchor.
  let nearest: { distance: number; node: Text; index: number } | undefined;
  for (const span of message.querySelectorAll<HTMLElement>(
    "[data-source-start]",
  )) {
    const node = span.firstChild;
    if (!(node instanceof Text) || !node.length) continue;
    const runs = sourceRuns(span);
    for (let i = 0; i < runs.length; i++) {
      const [rendered, source] = runs[i];
      const length = (runs[i + 1]?.[0] ?? node.length) - rendered;
      const offset = Math.max(0, Math.min(length - 1, target - source));
      const distance = Math.abs(source + offset - target);
      if (distance === 0) return characterRect(node, rendered + offset).top;
      if (!nearest || distance < nearest.distance)
        nearest = { distance, node, index: rendered + offset };
    }
  }
  // A captured Markdown delimiter can disappear when the stream closes it.
  // The closest source character remains in the same identified reply.
  if (nearest) return characterRect(nearest.node, nearest.index).top;
}

export function isHistoryVisible(
  container: HTMLElement | null,
): container is HTMLElement {
  return !!container && container.clientHeight > 0 && container.clientWidth > 0;
}

export function captureHistoryAnchor(
  container: HTMLElement,
): HistoryAnchor | null {
  if (!isHistoryVisible(container)) return null;
  const top = container.getBoundingClientRect().top;
  const messages = Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  const message =
    messages.find((node) => node.getBoundingClientRect().bottom > top) ||
    messages.at(-1);
  return message
    ? {
        id: message.dataset.messageId!,
        offset: message.getBoundingClientRect().top - top,
        text: captureTextAnchor(message, top),
      }
    : null;
}

export function restoreHistoryAnchor(
  container: HTMLElement,
  anchor: HistoryAnchor | null,
) {
  if (!anchor || !isHistoryVisible(container)) return;
  const messages = Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  const message =
    messages.find((node) => node.dataset.messageId === anchor.id) ||
    messages.find(
      (node) =>
        node.dataset.messageAliases &&
        JSON.parse(node.dataset.messageAliases).includes(anchor.id),
    );
  if (!message) return;
  const textTop = restoredTextTop(message, anchor);
  // Measure the original message, not the container: a coalesced live reply
  // can grow below it, and native scroll anchoring may already have moved it.
  container.scrollTop +=
    (textTop ?? message.getBoundingClientRect().top) -
    container.getBoundingClientRect().top -
    (textTop === undefined ? anchor.offset : anchor.text!.offset);
}
