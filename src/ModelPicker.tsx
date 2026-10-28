import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu, RefreshCw } from "lucide-react";
import type {
  AppState,
  Session,
  ModelDirectory,
  ModelSelection,
} from "./types";

const invoke = async (action: string, payload?: unknown) => {
  if (!window.desktop) throw new Error("请在桌面应用中连接会话服务");
  return window.desktop.invoke(action, payload);
};

function reason(error: unknown) {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      )
    : String(error);
}

const optionKey = (provider: string, model: string) =>
  `${provider}\u0000${model}`;

function selection(value: unknown): ModelSelection | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    !("model" in value) ||
    typeof value.model !== "string"
  )
    return;
  return {
    provider: value.provider,
    model: value.model,
    ...("reasoningEffort" in value && typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}

export function ModelPicker({
  state,
  session,
  connected,
  active,
  busy,
  onSelect,
  onError,
}: {
  state: AppState;
  session?: Session;
  connected: boolean;
  active: boolean;
  busy: boolean;
  onSelect: (value: ModelSelection & { sessionId: string }) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const provider = session?.provider || state.config.provider || "dsh";
  const epoch = state.connections?.[provider]?.epoch ?? 0;
  const sessionId = session?.sessionId || "";
  const projectionBlock = session?.projections;
  const projection = projectionBlock?.values.modelSelection;
  const projected = selection(projection?.next) || selection(projection?.lastUsed);
  // Only an authoritative modelSelection update may invalidate a local
  // receipt. Bind to this key's own sequence: unrelated projections (token
  // usage, context pressure) advance the store watermark but must not.
  // The model sequence is the only authoritative invalidation signal. A
  // baseline may change the value without representing a live model update.
  const projectionKey = JSON.stringify([
    provider,
    sessionId,
    epoch,
    projectionBlock?.modelSelectionSeq ?? "unknown",
  ]);
  const latestProjection = useRef({ key: projectionKey, revision: 0 });
  if (latestProjection.current.key !== projectionKey)
    latestProjection.current = {
      key: projectionKey,
      revision: latestProjection.current.revision + 1,
    };
  const projectionRevision = latestProjection.current.revision;
  const scopeKey = JSON.stringify([
    provider,
    sessionId,
    epoch,
    !!session?.readOnly,
  ]);
  const selectionScope = useRef({ key: scopeKey, revision: 0 });
  if (selectionScope.current.key !== scopeKey)
    selectionScope.current = {
      key: scopeKey,
      revision: selectionScope.current.revision + 1,
    };
  const scopeRevision = selectionScope.current.revision;
  const requests = useRef(0);
  const selectRequests = useRef(0);
  const [loaded, setLoaded] = useState<{
    requestId: number;
    scopeRevision: number;
    projectionRevisionAtStart: number;
    directory: ModelDirectory;
  } | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "warning" | "error"
  >("idle");
  const [loadError, setLoadError] = useState("");
  const [selecting, setSelecting] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirmed, setConfirmed] = useState<{
    scopeRevision: number;
    projectionRevision: number;
    current: ModelSelection;
  } | null>(null);

  useEffect(() => {
    const generation = ++requests.current;
    const projectionRevisionAtStart = projectionRevision;
    setStatus("idle");
    setLoadError("");
    setSelecting("");
    if (!sessionId || !active || !connected) {
      setConfirmed(null);
      return;
    }
    setStatus("loading");
    invoke("models", { sessionId })
      .then((value) => {
        if (generation !== requests.current) return;
        if (
          !value ||
          typeof value !== "object" ||
          !selection(value.current) ||
          !Array.isArray(value.groups) ||
          !Array.isArray(value.failures)
        )
          throw new Error("无法识别模型列表");
        setLoaded({
          requestId: generation,
          scopeRevision,
          projectionRevisionAtStart,
          directory: value,
        });
        // Partial provider failures degrade to a warning: healthy groups stay
        // selectable. Only an empty catalog (or a thrown request) is an error.
        const details = value.failures
          .map((failure: { message?: unknown; name?: unknown }) =>
            typeof failure?.message === "string" && failure.message
              ? failure.message
              : typeof failure?.name === "string" && failure.name
                ? failure.name
                : "模型供应商暂时不可用",
          )
          .filter(Boolean)
          .join("；");
        if (value.failures.length && !value.groups.length) {
          setStatus("error");
          setLoadError(details || "模型供应商暂时不可用");
        } else {
          setStatus(value.failures.length ? "warning" : "ready");
          setLoadError(details);
        }
      })
      .catch((error) => {
        if (generation !== requests.current) return;
        setStatus("error");
        setLoadError(reason(error));
      });
    return () => {
      if (generation === requests.current) requests.current++;
    };
  }, [active, connected, epoch, sessionId, retry, !!session?.readOnly]);

  if (!session)
    return (
      <span
        className="model-picker is-static"
        title="新会话使用平台默认模型，发送后可切换"
      >
        <Cpu size={11} aria-hidden="true" />
        <span>
          {state.host?.model ? `默认 · ${state.host.model}` : "默认模型"}
        </span>
      </span>
    );

  const directory =
    loaded?.scopeRevision === scopeRevision && loaded.requestId === requests.current
      ? loaded.directory
      : null;
  const options = (directory?.groups || []).flatMap((group) =>
    group.models.map((model) => ({ group, model })),
  );
  // A successful local write can precede its projection broadcast. Keep its
  // receipt only until the projection changes; a newer projection always wins,
  // including when the initial directory request finishes after that change.
  const receipt =
    confirmed?.scopeRevision === scopeRevision &&
    confirmed.projectionRevision === projectionRevision
      ? confirmed
      : null;
  const currentSelection =
    receipt?.current ||
    (directory && projectionRevision === loaded?.projectionRevisionAtStart
      ? directory.current
      : projected || directory?.current);
  const currentKey = currentSelection
    ? optionKey(currentSelection.provider, currentSelection.model)
    : "";
  const current = options.find(
    (option) => optionKey(option.group.id, option.model.id) === currentKey,
  );
  const label = current?.model.name || currentSelection?.model || "选择模型";
  const disabled =
    busy ||
    !connected ||
    !directory ||
    !!session.readOnly ||
    !["ready", "warning"].includes(status) ||
    !!selecting;

  async function change(key: string) {
    const option = options.find(
      (entry) => optionKey(entry.group.id, entry.model.id) === key,
    );
    if (disabled || !option || key === currentKey || !directory) return;
    const scope = scopeRevision;
    const requestId = ++selectRequests.current;
    const observedProjection = latestProjection.current.revision;
    const owner = currentSelection;
    const effort =
      owner?.provider === option.group.id &&
      owner.model === option.model.id &&
      owner.reasoningEffort
        ? owner.reasoningEffort
        : option.model.reasoning?.defaultEffort;
    setSelecting(key);
    try {
      const value = await onSelect({
        sessionId,
        provider: option.group.id,
        model: option.model.id,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      if (
        scope !== selectionScope.current.revision ||
        requestId !== selectRequests.current
      )
        return;
      const selected = selection(
        value && typeof value === "object" && "selected" in value
          ? value.selected
          : null,
      );
      if (!selected) throw new Error("无法识别模型切换结果，请重试加载模型");
      if (latestProjection.current.revision === observedProjection)
        setConfirmed({
          scopeRevision: scope,
          projectionRevision: observedProjection,
          current: selected,
        });
    } catch (error) {
      if (scope === selectionScope.current.revision && requestId === selectRequests.current) onError(reason(error));
    } finally {
      if (scope === selectionScope.current.revision && requestId === selectRequests.current) setSelecting("");
    }
  }

  return (
    <span
      className={`model-picker${
        status === "error" ? " is-error" : status === "warning" ? " is-warning" : ""
      }`}
      title={
        status === "error"
          ? `模型列表不可用：${loadError}`
          : status === "warning"
            ? `部分供应商失败：${loadError}`
            : session.readOnly
            ? "仅查看的会话不能切换模型"
            : directory?.routable === false
              ? "当前模型暂不可路由，可切换到其他模型"
              : "切换模型，对下一回合生效"
      }
    >
      <Cpu size={11} aria-hidden="true" />
      <select
        aria-label="切换模型"
        value={selecting || currentKey}
        disabled={disabled}
        onChange={(event) => void change(event.target.value)}
      >
        {!directory && !currentKey && (
          <option value="">
            {status === "error" ? "模型不可用" : "模型…"}
          </option>
        )}
        {!current && currentKey && (
          <option value={currentKey}>{label}</option>
        )}
        {directory?.groups.map((group) => (
          <optgroup key={group.id} label={group.name}>
            {group.models.map((model) => (
              <option
                key={optionKey(group.id, model.id)}
                value={optionKey(group.id, model.id)}
              >
                {model.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="model-chevron" size={9} aria-hidden="true" />
      {(status === "error" || status === "warning") && (
        <button
          type="button"
          className="icon-button"
          aria-label="重试加载模型"
          title={`重试加载模型${loadError ? `：${loadError}` : ""}`}
          disabled={!connected || busy}
          onClick={() => setRetry((value) => value + 1)}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
