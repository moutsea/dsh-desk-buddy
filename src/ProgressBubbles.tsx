import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { ChevronRight } from "lucide-react";
import { activeProgressItems } from "../shared/progress.mjs";
import {
  DECK_LIMIT,
  deckCapacity,
  deckIndices,
  deckLayout,
  deckSlots,
  deckTop,
  moveDeckPointer,
} from "../shared/progress-deck.mjs";

// Derive the item shape from the projection helper so the two cannot drift.
type ProgressItem = ReturnType<typeof activeProgressItems>[number];
type DeckPointer = { x: number; y: number; carry: number };

// A pointer that re-appears after a pause (ms), or jumps further than the deck
// is wide (px), is a new origin rather than a continuation of the same drag.
const STALE_POINTER = 400; // ms without pointer events
const JUMP_LIMIT = 320; // px, wider than the deck itself
const LABEL_DETAIL = 80; // characters of preview text kept in the aria-label

export function ProgressBubbles({
  items,
  headroom,
  width,
  onOpen,
}: {
  items: ProgressItem[];
  headroom: number;
  width: number;
  onOpen: (sessionId: string) => void;
}) {
  const stack = useRef<HTMLDivElement>(null);
  const incoming = items.map((item) => item.sessionId).reverse();
  const membership = JSON.stringify([...incoming].sort());
  // Card order is committed when the set of sessions changes: streaming text
  // and activity updates never reorder cards that are already on screen.
  const committed = useRef({ membership, order: incoming });
  if (committed.current.membership !== membership) {
    const order = [
      ...committed.current.order.filter((id) => incoming.includes(id)),
      ...incoming.filter((id) => !committed.current.order.includes(id)),
    ];
    committed.current = { membership, order };
  }
  const ids = committed.current.order;
  const byId = new Map(items.map((item) => [item.sessionId, item]));
  const [selected, setSelected] = useState(incoming.at(-1)!);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const active = ids.includes(selected) ? selected : ids.at(-1)!;
  const activeIndex = ids.indexOf(active);
  const selection = useRef(active);
  const pointer = useRef<DeckPointer | null>(null);
  const pointerAt = useRef(0);
  const lastPoint = useRef({ x: 0, y: 0 });
  const pendingFocus = useRef<string | null>(null);
  const browsing = hovered || keyboard;
  // Cards are clamped to the space above the pet so the deck never covers its
  // head, which would swallow clicks meant for the character.
  const capacity = deckCapacity(headroom);
  const visible = deckIndices(ids.length, activeIndex, browsing, capacity);
  // Only folded decks reorder: with five cards or fewer the selection follows
  // the card under the pointer, so rotating slots would loop through
  // leave/enter as the cards move beneath it.
  const slots = deckSlots(
    visible,
    activeIndex,
    !browsing && ids.length > DECK_LIMIT,
  );
  const layout = deckLayout(slots.length, width);
  const select = (index: number, focus = false) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, index))];
    selection.current = id;
    if (focus) pendingFocus.current = id;
    setSelected(id);
  };
  useLayoutEffect(() => {
    selection.current = active;
    pointer.current = null;
  }, [membership]);
  useLayoutEffect(() => {
    if (pendingFocus.current === active) {
      stack.current
        ?.querySelector<HTMLButtonElement>(".pet-progress-bubble.is-active")
        ?.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, [active]);
  const followPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    lastPoint.current = { x: event.clientX, y: event.clientY };
    if (ids.length <= DECK_LIMIT) {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-session-id]")
          : null;
      if (target?.dataset.sessionId)
        select(ids.indexOf(target.dataset.sessionId));
      return;
    }
    const last = pointer.current;
    const jump = last
      ? Math.hypot(event.clientX - last.x, event.clientY - last.y)
      : 0;
    if (
      jump > JUMP_LIMIT ||
      event.timeStamp - pointerAt.current > STALE_POINTER
    )
      pointer.current = null;
    pointerAt.current = event.timeStamp;
    const result = moveDeckPointer(
      pointer.current,
      { x: event.clientX, y: event.clientY },
      ids.indexOf(selection.current),
      ids.length,
    );
    pointer.current = result.pointer;
    if (ids[result.selected] !== selection.current) select(result.selected);
  };
  const enterDeck = (event: PointerEvent<HTMLDivElement>) => {
    setHovered(true);
    lastPoint.current = { x: event.clientX, y: event.clientY };
    pointer.current = { x: event.clientX, y: event.clientY, carry: 0 };
    pointerAt.current = event.timeStamp;
    if (ids.length <= DECK_LIMIT) followPointer(event);
  };
  const leaveDeck = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stack.current?.getBoundingClientRect();
    // Folding moves cards under the pointer, which reports `pointerleave` (with
    // empty coordinates) even though the deck is still hovered; only a real
    // exit ends browsing.
    const noPosition = event.clientX === 0 && event.clientY === 0;
    const x = noPosition ? lastPoint.current.x : event.clientX;
    const y = noPosition ? lastPoint.current.y : event.clientY;
    if (
      rect &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    )
      return;
    setHovered(false);
    pointer.current = null;
  };
  return (
    <div
      ref={stack}
      className={`pet-progress-stack${browsing ? " is-browsing" : ""}`}
      role="group"
      aria-label="进行中的会话"
      data-selected-session={active}
      data-selected-index={activeIndex}
      data-total={ids.length}
      style={
        {
          width: layout.width,
          height: layout.height,
          left: (width - layout.width) / 2,
          top: deckTop(headroom, layout.height),
        } as CSSProperties
      }
      onPointerEnter={enterDeck}
      onPointerMove={followPointer}
      onPointerLeave={leaveDeck}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setKeyboard(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setKeyboard(false);
      }}
      onKeyDown={(event) => {
        // Enter opens the selected card; a pointer click opens the card it hits.
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onOpen(selection.current);
          return;
        }
        const index = ids.indexOf(selection.current);
        const keys: Record<string, number> = {
          ArrowUp: index - 1,
          ArrowRight: index - 1,
          ArrowDown: index + 1,
          ArrowLeft: index + 1,
          Home: 0,
          End: ids.length - 1,
        };
        if (!Object.hasOwn(keys, event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        setKeyboard(true);
        pointer.current = null;
        select(keys[event.key], true);
      }}
    >
      {slots.map((index, slot) => {
        const id = ids[index],
          item = byId.get(id)!,
          isActive = id === active;
        const position = layout.positions[slot];
        const geometry = {
          left: position.x,
          top: position.y,
          width: layout.cardWidth,
          height: layout.cardHeight,
        };
        // Hit target and painted card share one layer so the pointer always
        // reaches the card it is actually looking at. Only the browsed card is
        // lifted: lifting the selected card at rest covers the neighbours' text
        // and click strips, so the resting deck keeps strict slot order (the
        // selected card is marked by its border, and owns the front slot once
        // the deck folds).
        const layer = isActive && browsing ? DECK_LIMIT + 1 : slot + 1;
        const detail =
          item.text && item.text !== item.label
            ? `，${
                item.text.length > LABEL_DETAIL
                  ? `${item.text.slice(0, LABEL_DETAIL)}…`
                  : item.text
              }`
            : "";
        return (
          <div className="progress-entry" key={id}>
            <button
              data-interactive
              data-session-id={id}
              className={`pet-progress-bubble${isActive ? " is-active" : ""}`}
              style={{ ...geometry, zIndex: layer }}
              aria-label={`查看进度：${item.title}，${item.label}${detail}`}
              tabIndex={isActive ? 0 : -1}
              title={
                ids.length > DECK_LIMIT
                  ? "沿斜向移动切换会话，点击打开该会话"
                  : "点击打开对应对话"
              }
              onFocus={() => select(index)}
              onMouseDown={(event) => {
                if (ids.length > DECK_LIMIT) event.preventDefault();
              }}
              onClick={() => onOpen(id)}
            />
            <span
              className={`progress-card ${item.status}${isActive ? " is-active" : ""}`}
              data-session-id={id}
              aria-hidden="true"
              style={{ ...geometry, zIndex: layer }}
            >
              <span className="progress-content">
                <span className="progress-heading">
                  <span className={`status-dot ${item.status}`} />
                  <strong>{item.title}</strong>
                  <ChevronRight size={13} />
                </span>
                <span className="progress-preview">{item.text}</span>
                <span className="progress-footer">{item.label}</span>
              </span>
            </span>
          </div>
        );
      })}
      {slots.length > 1 && (
        <span
          className="progress-deck-caption"
          aria-live={keyboard || !browsing ? "polite" : "off"}
        >
          {activeIndex + 1} / {ids.length}
          {ids.length > slots.length &&
            (browsing
              ? " · 沿斜向移动切换"
              : ` · 已折叠 ${ids.length - slots.length} 个`)}
        </span>
      )}
    </div>
  );
}
