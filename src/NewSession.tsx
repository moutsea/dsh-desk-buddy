import { useState } from "react";
import { Plus } from "lucide-react";
import type { AppState, Provider } from "./types";
import { platformConnection, providerLabel } from "./platforms";

export function NewSession({
  state,
  busy,
  run,
  onCreated,
  iconOnly = false,
}: {
  state: AppState;
  busy: boolean;
  run: (action: string, payload?: any) => Promise<any>;
  onCreated?: () => void;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const available = (["dsh", "codex"] as Provider[]).filter(
    (provider) => platformConnection(state, provider).status === "connected",
  );
  async function create(provider: Provider) {
    if (await run("create", { provider })) {
      setOpen(false);
      onCreated?.();
    }
  }
  return (
    <div className="new-session-control">
      <button
        className={iconOnly ? "icon-button" : "new-session primary"}
        aria-label="新建会话"
        title="选择平台并新建会话"
        aria-expanded={open}
        disabled={busy || !available.length}
        onClick={() =>
          available.length === 1 ? void create(available[0]) : setOpen(!open)
        }
      >
        <Plus size={iconOnly ? 18 : 15} />
        {!iconOnly && "新建会话"}
      </button>
      {open && (
        <div
          className="new-session-menu"
          role="group"
          aria-label="选择新会话平台"
        >
          <span>在哪个平台开始？</span>
          {(["dsh", "codex"] as Provider[]).map((provider) => (
            <button
              key={provider}
              className={`new-platform ${provider}`}
              disabled={busy || !available.includes(provider)}
              onClick={() => void create(provider)}
            >
              <span className={`provider-badge ${provider}`}>
                {providerLabel(provider)}
              </span>
              新建 {providerLabel(provider)} 会话
            </button>
          ))}
          <button className="muted" onClick={() => setOpen(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
