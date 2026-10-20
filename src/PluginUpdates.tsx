import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

type Update = {
  phase: string;
  currentVersion: string;
  latestVersion?: string;
  downloaded?: number;
  size?: number;
  error?: string;
  unavailable?: string;
};

export function PluginUpdates() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const live = useRef(false);
  const apply = (value: Update) => {
    setUpdate(value);
    setError("");
  };
  const report = (err: unknown) => {
    setError(
      (err as Error).message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      ),
    );
  };
  useEffect(() => {
    live.current = true;
    let reading = false;
    const refresh = async () => {
      if (pending.current || reading) return;
      reading = true;
      const expected = revision.current;
      try {
        const value = await window.desktop?.invoke("pluginUpdateStatus");
        if (live.current && expected === revision.current && value)
          apply(value);
      } catch (err) {
        if (live.current && expected === revision.current) report(err);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1200);
    return () => {
      live.current = false;
      revision.current++;
      clearInterval(timer);
    };
  }, []);
  const request = async (action: string) => {
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      const value = await window.desktop?.invoke(action, update?.latestVersion);
      if (live.current && value) apply(value);
    } catch (err) {
      if (live.current) report(err);
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  };
  const working = [
    "checking",
    "downloading",
    "installing",
    "restoring",
  ].includes(update?.phase || "");
  const restart = update?.phase === "restart-required";
  const disabled = busy || working || restart || !!update?.unavailable;
  const labels: Record<string, string> = {
    idle: "手动检查 GitHub 上的最新正式版",
    checking: "正在检查新版本…",
    current: "当前已是最新版本",
    available: `发现新版本 v${update?.latestVersion}`,
    downloading: `正在下载更新包… ${Math.floor((update?.downloaded || 0) / 1024 / 1024)} MB`,
    installing: "校验完成，正在更新插件，请保持 DSH 打开…",
    restoring: "更新未完成，正在恢复旧版插件…",
    "restart-required": `v${update?.latestVersion} 已安装，请在任务完成后重启 DSH`,
    error: "更新未完成，可以重试",
  };
  return (
    <section className="settings-card plugin-updates" aria-label="插件更新">
      <div className="section-title">
        <h2>
          <Download size={14} />
          插件更新
        </h2>
        <span className="muted">
          {update ? `当前 v${update.currentVersion}` : "读取版本中…"}
        </span>
      </div>
      <p className="plugin-update-status" role="status">
        {update?.unavailable ||
          labels[update?.phase || ""] ||
          "正在读取更新状态…"}
      </p>
      {update?.phase === "downloading" && (
        <progress
          aria-label="插件下载进度"
          max={update.size || 1}
          value={update.downloaded || 0}
        />
      )}
      {(error || update?.error) && (
        <p className="plugin-update-error" role="alert">
          {error || update?.error}
        </p>
      )}
      <div className="plugin-update-buttons">
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void request("checkPluginUpdate")}
        >
          <RefreshCw size={13} className={working ? "spin" : ""} />
          检查更新
        </button>
        {update?.latestVersion && !restart && (
          <button
            className="primary"
            disabled={disabled}
            onClick={() => void request("installPluginUpdate")}
          >
            下载并更新至 v{update.latestVersion}
          </button>
        )}
      </div>
      {!update?.unavailable && (
        <p className="plugin-update-note">
          只在点击后检查和下载。升级会短暂关闭桌宠，保留设置与对话；完成后重启
          DSH。
        </p>
      )}
    </section>
  );
}
