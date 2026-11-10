import { memo } from "react";
import type { ConsoleLine, ConsoleLineKind } from "./useConsoleFeed";

/**
 * 球面两侧的数据流（终端语汇：等宽 + `>` 提示符 + 单色 + 行尾光标）。
 *
 * 降噪纪律：单行正文、无容器、无渐变、行级 opacity 阶梯从下往上淡出，
 * 主焦点留给球心。左侧读「参谋」（阿黎自己的思考与工具），右侧读「席位」（成员在干活）。
 */

const KIND_LABEL: Record<ConsoleLineKind, string> = {
  think: "思考",
  tool: "工具",
  say: "回报",
  cmd: "派单",
  alert: "卡点",
  done: "结束",
};

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const Line = memo(function Line({ line, alert }: { line: ConsoleLine; alert: boolean }) {
  return (
    <div className={`cs-fl-item${alert ? " hot" : ""}`}>
      <div className="cs-fl-meta">
        <span className="cs-fl-ts">{hhmmss(line.at)}</span>
        <span className="cs-fl-kind">{KIND_LABEL[line.kind]}</span>
        <span className="cs-fl-who">{line.who}</span>
      </div>
      <div className={`cs-fl-text${line.live ? " typing" : ""}`}>{line.text || "…"}</div>
    </div>
  );
});

export function Stream({
  side,
  lines,
  max,
}: {
  side: "left" | "right";
  lines: ConsoleLine[];
  max: number;
}) {
  // 只留最近 max 行：新的在下面，旧的从顶部顶出
  const view = lines.slice(Math.max(0, lines.length - max));
  // 没有事件就不占位：空态不该在球面两侧留两行"无输出"的噪音
  if (!view.length) return null;

  return (
    <div className={`cs-flow ${side}`}>
      <div className={`cs-flow-cap ${side}`}>
        <i />
        {side === "left" ? "参谋" : "席位"}
        <span className="mono">{String(view.length).padStart(2, "0")}</span>
      </div>
      <div className="cs-flow-body">
        {view.map((l) => (
          <Line key={l.id} line={l} alert={l.kind === "alert"} />
        ))}
      </div>
    </div>
  );
}
