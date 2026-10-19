import { Check, Shuffle, Sparkles } from "lucide-react";
import { EXPRESSIONS, isExpressionId } from "../shared/expressions.mjs";
import { Mascot } from "./Mascot";
import type { AppState } from "./types";

export function Expressions({
  state,
  mood,
  busy,
  run,
}: {
  state: AppState;
  mood: string;
  busy: boolean;
  run: (action: string, payload?: any) => Promise<any>;
}) {
  const selection = state.config.expression || "auto";
  return (
    <div className="page-content expressions-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">A MOOD FOR EVERY LITTLE MOMENT</span>
          <h1>今天，是什么心情？</h1>
        </div>
        <Sparkles size={24} strokeWidth={1.3} />
      </div>
      <p className="expressions-intro">
        每个表情都有自己的小动作，点选后会在桌面播放。
      </p>
      <section className="settings-card motion-setting">
        <div className="toggle-row">
          <div>
            <h2>让她动起来</h2>
            <p>眨眼、挥手、打字、翻书，陪你一起忙</p>
          </div>
          <button
            role="switch"
            aria-label="动态动作"
            aria-checked={state.config.animations !== false}
            disabled={busy}
            className={`switch ${state.config.animations !== false ? "on" : ""}`}
            onClick={() => run("animations", state.config.animations === false)}
          >
            <span />
          </button>
        </div>
      </section>
      <div role="radiogroup" aria-label="桌宠表情">
        <button
          role="radio"
          aria-checked={selection === "auto"}
          disabled={busy}
          className={`expression-auto ${selection === "auto" ? "current" : ""}`}
          onClick={() => run("expression", "auto")}
        >
          <div className="expression-auto-preview">
            <Mascot
              small
              mood={mood}
              expression={isExpressionId(selection) ? selection : undefined}
            />
          </div>
          <div>
            <strong>
              <Shuffle size={14} />
              自动跟随会话
            </strong>
            <span>
              读资料时学习，开工时敲电脑
              <br />
              报错时震惊，完成后庆祝、开心
            </span>
          </div>
          {selection === "auto" && <Check size={17} />}
        </button>
        <div className="expression-grid">
          {EXPRESSIONS.map((item) => (
            <button
              key={item.id}
              role="radio"
              aria-checked={selection === item.id}
              aria-label={item.label}
              title={item.description}
              disabled={busy}
              className={`expression-choice ${selection === item.id ? "current" : ""}`}
              onClick={() => run("expression", item.id)}
            >
              <div className="expression-preview">
                <Mascot small expression={item.id} />
              </div>
              <span>
                {item.label}
                {selection === item.id && <Check size={12} />}
              </span>
            </button>
          ))}
        </div>
      </div>
      <section className="settings-card expression-behaviour">
        <div className="toggle-row">
          <div>
            <h2>空闲时也有小情绪</h2>
            <p>偶尔吃饭、读书；等久了会无聊、犯困</p>
          </div>
          <button
            disabled={busy}
            role="switch"
            aria-label="空闲随机表情"
            aria-checked={state.config.idleExpressions !== false}
            className={`switch ${state.config.idleExpressions !== false ? "on" : ""}`}
            onClick={() =>
              run("idleExpressions", state.config.idleExpressions === false)
            }
          >
            <span />
          </button>
        </div>
      </section>
      <div className="expression-help">
        对话中的小头像也会跟随当前会话变化。
        <br />
        需要你回应时会歪头等待；开始新任务后立刻进入状态。
      </div>
      <p className="expression-help">
        固定表情只改变角色外观，执行状态照常提示。
        <br />
        也可以右键点击桌宠，快速切换表情。
      </p>
    </div>
  );
}
