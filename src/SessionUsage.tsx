import { ChevronDown } from "lucide-react";
import {
  formatRate,
  formatTokens,
  sessionUsage,
} from "../shared/session-usage.mjs";
import type { Session } from "./types";

export function SessionUsage({ session }: { session: Session }) {
  const usage = sessionUsage(session.projections?.values);
  const contextLabel = usage.contextEstimated ? "预计上下文" : "最近上下文";
  const contextSize = `${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)}`;
  const details = [
    ["输入 Token", formatTokens(usage.input)],
    ["输出 Token", formatTokens(usage.output)],
    ["未缓存输入", formatTokens(usage.uncachedInput)],
    ["缓存读取", formatTokens(usage.cacheRead)],
    ["缓存写入", formatTokens(usage.cacheWrite)],
    [
      "平均生成速度",
      usage.tokensPerSecond === null
        ? "—"
        : `${usage.tokensPerSecond.toFixed(1)} token/s`,
    ],
    [
      "平均首字耗时",
      usage.firstTokenSeconds === null
        ? "—"
        : `${usage.firstTokenSeconds.toFixed(2)} s`,
    ],
    [
      "对话轮次 / 步数",
      `${formatTokens(usage.turns)} / ${formatTokens(usage.steps)}`,
    ],
  ];
  return (
    <details className="session-usage" aria-label="当前会话用量">
      <summary title="展开或收起当前会话用量明细">
        <span title={`累计 Token：${formatTokens(usage.total)}`}>
          <span className="usage-label">Token</span>
          <strong data-metric="total">{formatTokens(usage.total, true)}</strong>
        </span>
        <span title="缓存读取 Token ÷ 全部输入 Token">
          <span className="usage-label">缓存命中</span>
          <strong data-metric="cache">{formatRate(usage.cacheHitRate)}</strong>
        </span>
        <span title={`${contextLabel}：${contextSize} Token`}>
          <span className="usage-label">上下文</span>
          <strong data-metric="context">
            {usage.contextEstimated && usage.contextRate !== null ? "≈" : ""}
            {formatRate(usage.contextRate)}
          </strong>
        </span>
        <ChevronDown size={12} className="usage-chevron" aria-hidden="true" />
      </summary>
      <div className="usage-detail">
        <p className="usage-scope">当前会话累计 · 随 DSH 上报更新</p>
        <dl>
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div className="usage-context">
            <dt>{contextLabel}</dt>
            <dd>{contextSize} Token</dd>
          </div>
        </dl>
        <p className="usage-note">
          输入含缓存读取和写入；上下文为单次请求占用。
          “—”表示暂未上报或暂无可计算样本。
        </p>
      </div>
    </details>
  );
}
