import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { ChevronRight, X } from "lucide-react";
import { activeProgressItems } from "../shared/progress.mjs";
import {
  DECK_LIMIT,
  deckCapacity,
  deckLayout,
  deckTop,
  moveDeckPointer,
  reconcileDeckOrder,
  reconcileDeckView,
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
  onDismiss,
}: {
  items: ProgressItem[];
  headroom: number;
  width: number;
  onOpen: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}) {
  const stack = useRef<HTMLDivElement>(null);
  const incoming = items.map((item) => item.sessionId).reverse();
  const [selected, setSelected] = useState(incoming.at(-1)!);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const browsing = hovered || keyboard;
  const committed = useRef<{
    order: string[];
    completed: Record<string, number>;
    automatic?: string;
  }>({
    order: incoming,
    completed: {},
  });
  const next = reconcileDeckOrder(committed.current, items, browsing);
  committed.current = next;
  const ids = next.order;
  const orderKey = JSON.stringify(ids);
  const byId = new Map(items.map((item) => [item.sessionId, item]));
  const active =
    next.promoted ?? (ids.includes(selected) ? selected : ids.at(-1)!);
  // Commit the fallback as well as completion promotion: a dismissed ID must
  // not become selected again when its next task makes the bubble reappear.
  if (active !== selected) {
    // Replacing a removed selection is automatic too. If the replacement
    // restarts, it must yield to completed work until the user chooses a card.
    if (!ids.includes(selected)) next.automatic = active;
    setSelected(active);
  }
  const activeIndex = ids.indexOf(active);
  const selection = useRef(active);
  selection.current = active;
  const pointer = useRef<DeckPointer | null>(null);
  const pointerAt = useRef(0);
  const lastPoint = useRef({ x: 0, y: 0 });
  const pendingFocus = useRef<string | null>(null);
  // Cards are clamped to the space above the pet so the deck never covers its
  // head, which would swallow clicks meant for the character.
  const capacity = deckCapacity(headroom);
  const view = useRef<ReturnType<typeof reconcileDeckView> | undefined>(
    undefined,
  );
  const display = reconcileDeckView(view.current, {
    ids,
    active,
    hovered,
    browsing,
    capacity,
    width,
    headroom,
  });
  const { slots, rotate: needsRotation } = display;
  const compactCaption = slots.length === 1 && needsRotation;
  const layout = deckLayout(slots.length, width);
  const select = (index: number, focus = false) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, index))];
    committed.current.automatic = undefined;
    selection.current = id;
    if (focus) pendingFocus.current = id;
    setSelected(id);
  };
  const dismiss = (id: string) => {
    committed.current.automatic = undefined;
    if (keyboard) {
      const remaining = ids.filter((item) => item !== id);
      const next = remaining[Math.min(ids.indexOf(id), remaining.length - 1)];
      if (next) {
        pendingFocus.current = next;
        setSelected(next);
      }
    }
    onDismiss(id);
  };
  useLayoutEffect(() => {
    view.current = display;
  });
  useLayoutEffect(() => {
    // Drop accumulated rotation, but keep the cursor origin when membership
    // changes under it so the next deliberate movement still browses a card.
    pointer.current = hovered ? { ...lastPoint.current, carry: 0 } : null;
  }, [orderKey, capacity, width]);
  useLayoutEffect(() => {
    if (pendingFocus.current === active) {
      stack.current
        ?.querySelector<HTMLButtonElement>(".pet-progress-bubble.is-active")
        ?.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, [active]);
  useLayoutEffect(() => {
    // Removing a focused card need not fire blur. Validate after the keyboard
    // focus handoff above, so ordinary arrow navigation still owns the focus.
    if (keyboard && !stack.current?.contains(document.activeElement))
      setKeyboard(false);
  });
  useLayoutEffect(() => {
    if (!hovered) return;
    const leave = () => {
      setHovered(false);
      pointer.current = null;
    };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") return;
      const rect = stack.current?.getBoundingClientRect();
      if (
        !rect ||
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        leave();
    };
    // Gaps are click-through. After entering one, subsequent moves no longer
    // reach the stack, so observe the rest of the exit at the document boundary.
    document.addEventListener("pointermove", move, true);
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
    };
  }, [hovered]);
  const followPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    // Window blur clears browsing without necessarily ending DOM :hover.
    // Movement inside the deck can resume without another pointerenter.
    setHovered(true);
    lastPoint.current = { x: event.clientX, y: event.clientY };
    if (
      event.target instanceof Element &&
      event.target.closest(".progress-dismiss")
    ) {
      pointer.current = { x: event.clientX, y: event.clientY, carry: 0 };
      pointerAt.current = event.timeStamp;
      return;
    }
    if (!needsRotation) {
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
    if (!needsRotation) followPointer(event);
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
  const caption = (
    <span
      className={`progress-deck-caption${compactCaption ? " is-inline" : ""}`}
      aria-live={keyboard || !browsing ? "polite" : "off"}
    >
      {activeIndex + 1} / {ids.length}
      {needsRotation &&
        (browsing
          ? " · 沿斜向移动切换"
          : ` · 已折叠 ${ids.length - slots.length} 个`)}
    </span>
  );
  return (
    <div
      ref={stack}
      className={`pet-progress-stack${browsing ? " is-browsing" : ""}`}
      role="group"
      aria-label="会话气泡"
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
        // The close control owns Enter/Space; never open a chat while closing it.
        if (
          event.target instanceof Element &&
          event.target.closest(".progress-dismiss")
        )
          return;
        // Keyboard activation follows the visible selection even when pointer
        // rotation left DOM focus on another card. Suppress Space's native click.
        if (event.key === "Enter" || event.key === " ") {
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
      {slots.map((id, slot) => {
        if (id === null) return null;
        const index = ids.indexOf(id),
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
              data-provider={item.provider}
              className={`pet-progress-bubble${isActive ? " is-active" : ""}`}
              style={{ ...geometry, zIndex: layer }}
              aria-label={`查看进度：${item.title}，${item.label}${detail}${needsRotation ? `，第 ${index + 1} 个，共 ${ids.length} 个会话` : ""}`}
              tabIndex={isActive ? 0 : -1}
              title={
                needsRotation
                  ? "沿斜向移动切换会话，点击打开该会话"
                  : "点击打开对应对话"
              }
              onFocus={() => select(index)}
              onMouseDown={(event) => {
                if (needsRotation) event.preventDefault();
              }}
              onClick={() => onOpen(id)}
            />
            <span
              className={`progress-card ${item.status}${isActive ? " is-active" : ""}`}
              data-session-id={id}
              data-provider={item.provider}
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
                <span
                  className={`progress-footer${compactCaption ? " has-deck-caption" : ""}`}
                >
                  <span>
                    <span className={`provider-badge ${item.provider}`}>
                      {item.provider === "codex" ? "Codex" : "DSH"}
                    </span>{" "}
                    {item.label}
                  </span>
                  {compactCaption && caption}
                </span>
              </span>
            </span>
            <button
              data-interactive
              data-session-id={id}
              data-provider={item.provider}
              className={`progress-dismiss${isActive ? " is-active" : ""}`}
              style={{
                left: position.x + layout.cardWidth - 28,
                top: position.y + 3,
                zIndex: layer,
              }}
              aria-label={`关闭气泡：${item.title}`}
              title="关闭气泡显示，不会停止任务"
              tabIndex={isActive ? 0 : -1}
              disabled={!isActive}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                dismiss(id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      {slots.length > 1 && caption}
    </div>
  );
}
