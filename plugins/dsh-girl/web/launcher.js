if (!document.querySelector("deepseek-girl-manager")) {
  const host = document.createElement("deepseek-girl-manager");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{position:fixed;width:max-content;z-index:2147483000;font:12px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}button{position:relative;z-index:1;display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid #cbdcf3;border-radius:15px;background:#f4f8fff5;color:#6380ae;padding:7px 12px;cursor:grab;touch-action:none;user-select:none;box-shadow:0 3px 12px #34527a12}button:active{cursor:grabbing}button img{width:24px;height:24px;border-radius:6px;pointer-events:none}iframe{position:fixed;box-sizing:border-box;border:1px solid #d5e1f3;border-radius:20px;background:#f7f9ff;box-shadow:0 8px 35px #344b7420}button:focus-visible{outline:2px solid #8aabda;outline-offset:3px}";
  const button = document.createElement("button");
  button.textContent = "dsh-desk-buddy";
  const icon = document.createElement("img");
  icon.src = "/dsh-girl/icon.png";
  icon.alt = "";
  button.prepend(icon);
  button.title = "点击管理；拖动或使用方向键调整位置；Home 恢复默认位置";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "dsg-management");
  let frame;
  let position;
  let drag;
  let moved = false;
  const storageKey = "dsh-desk-buddy-launcher-position";
  const clamp = (value, maximum) => Math.max(12, Math.min(value, maximum));
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(position));
    } catch {}
  };
  const layout = () => {
    const bounds = button.getBoundingClientRect();
    position ||= {
      x: innerWidth - bounds.width - 18,
      y: innerHeight - bounds.height - 18,
    };
    position.x = clamp(position.x, innerWidth - bounds.width - 12);
    position.y = clamp(position.y, innerHeight - bounds.height - 12);
    host.style.left = `${position.x}px`;
    host.style.top = `${position.y}px`;
    if (frame) {
      const width = Math.min(400, innerWidth - 24);
      const above = Math.max(0, position.y - 20);
      const below = Math.max(0, innerHeight - position.y - bounds.height - 20);
      const openAbove = above >= below;
      // Fit on one side of the launcher; clamping a full-height panel back
      // into the viewport can otherwise place it directly over the button.
      const height = Math.min(760, openAbove ? above : below);
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      frame.style.left = `${clamp(position.x > innerWidth / 2 ? position.x + bounds.width - width : position.x, innerWidth - width - 12)}px`;
      frame.style.top = `${openAbove ? position.y - height - 8 : position.y + bounds.height + 8}px`;
    }
  };
  const closePanel = () => {
    if (!frame || frame.hidden) return false;
    frame.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return true;
  };
  const escapePanel = (event) => {
    if (event.key !== "Escape" || event.isComposing || !closePanel()) return;
    event.preventDefault();
    event.stopPropagation();
    button.focus({ preventScroll: true });
  };
  document.addEventListener("keydown", escapePanel, true);
  document.addEventListener(
    "pointerdown",
    (event) => {
      // composedPath keeps clicks on the shadow-root button inside. Pointer
      // events within the iframe stay in its own document and do not dismiss it.
      if (!event.composedPath().includes(host)) closePanel();
    },
    true,
  );
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    moved = false;
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
    };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!moved && Math.hypot(deltaX, deltaY) < 5) return;
    moved = true;
    position = { x: drag.x + deltaX, y: drag.y + deltaY };
    layout();
  });
  const endDrag = () => {
    if (drag && moved) persist();
    drag = null;
  };
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);
  button.addEventListener("lostpointercapture", endDrag);
  button.addEventListener("keydown", (event) => {
    moved = false;
    const directions = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (event.key === "Home") position = null;
    else if (directions[event.key]) {
      const [horizontal, vertical] = directions[event.key];
      position.x += horizontal * (event.shiftKey ? 40 : 10);
      position.y += vertical * (event.shiftKey ? 40 : 10);
    } else return;
    event.preventDefault();
    layout();
    persist();
  });
  button.onclick = () => {
    if (moved) {
      moved = false;
      return;
    }
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "dsg-management";
      frame.src = "/dsh-girl/";
      frame.title = "dsh-desk-buddy 桌宠管理";
      frame.addEventListener("load", () => {
        // Keyboard events in an iframe do not bubble to the parent document.
        frame.contentDocument?.addEventListener("keydown", escapePanel, true);
      });
      root.prepend(frame);
    } else frame.hidden = !frame.hidden;
    button.setAttribute("aria-expanded", String(!frame.hidden));
    layout();
  };
  root.append(style, button);
  document.body.append(host);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
      position = { x: saved.x, y: saved.y };
  } catch {}
  layout();
  addEventListener("resize", () => {
    layout();
    persist();
  });
}
