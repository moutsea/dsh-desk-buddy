import { useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

const THRESHOLD = 5;
const call = (action: string, point?: { x: number; y: number }) => {
  return window.desktop?.invoke(action, point).catch(() => null);
};

export function usePetDrag() {
  const [held, setHeld] = useState(false),
    [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
    target: HTMLElement;
  } | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0),
    suppressClick = useRef(false);
  const flush = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (pending.current) call("drag:move", pending.current);
    pending.current = null;
  };
  const finish = async () => {
    const current = gesture.current;
    if (!current) return { dragged: false, moved: false };
    gesture.current = null;
    flush();
    const result = call("drag:end");
    setHeld(false);
    setDragging(false);
    if (current.target.hasPointerCapture(current.id))
      current.target.releasePointerCapture(current.id);
    const moved = (await result)?.moved === true;
    return { dragged: current.moved, moved: current.moved && moved };
  };
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      finish();
    };
  }, []);
  return {
    held,
    dragging,
    isHeld: () => gesture.current !== null,
    preventClick(event: ReactMouseEvent) {
      if (!suppressClick.current || event.detail === 0) return false;
      event.preventDefault();
      return true;
    },
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary || gesture.current) return;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      gesture.current = {
        id: event.pointerId,
        x: event.screenX,
        y: event.screenY,
        moved: false,
        target,
      };
      suppressClick.current = false;
      setHeld(true);
      call("drag:start", { x: event.screenX, y: event.screenY });
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      if (
        !current.moved &&
        Math.hypot(event.screenX - current.x, event.screenY - current.y) <
          THRESHOLD
      )
        return;
      if (!current.moved) {
        current.moved = true;
        suppressClick.current = true;
        setDragging(true);
      }
      pending.current = { x: event.screenX, y: event.screenY };
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  };
}
export type PetDrag = ReturnType<typeof usePetDrag>;
