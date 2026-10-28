/** The same text layout is used for both streamed blocks and durable messages.
 * @param {any} value */
export function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

// Legacy and Codex deltas without an index belong to a single text block.
export function textBlockIndex(chunk) {
  return Number.isSafeInteger(chunk.index) ? chunk.index : 0;
}

/** Assemble text with the same block order and separators as the final message. */
export function reduceTextBlocks(previous, chunk) {
  if (
    chunk?.type !== "text-delta" &&
    !(chunk?.type === "block-start" && chunk.blockType === "text") &&
    !(chunk?.type === "block-end" && chunk.block?.type === "text")
  )
    return previous;
  const index = textBlockIndex(chunk);
  const blocks = previous.textBlocks || [];
  const position = blocks.findIndex((block) => block.index === index);
  const old = blocks[position];
  if (old?.closed || (old && chunk.type === "block-start")) return previous;
  const block = {
    index,
    type: "text",
    text:
      chunk.type === "block-end"
        ? chunk.block.text
        : (old?.text || "") + (chunk.type === "text-delta" ? chunk.text : ""),
    closed: chunk.type === "block-end",
  };
  // Empty blocks also contribute a separator. Keep published snapshots immutable.
  const textBlocks =
    position < 0
      ? [...blocks, block]
      : blocks.map((entry, i) => (i === position ? block : entry));
  return { ...previous, textBlocks, text: contentText(textBlocks) };
}
