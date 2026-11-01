import { useState } from "react";
import type { PermissionMode } from "../../shared/contract";
import { Avatar } from "./Avatar";

const PERM_LABEL: Record<PermissionMode, string> = {
  plan: "plan",
  ask: "ask",
  auto: "auto",
  full: "full",
};

export function Composer({
  permission,
  configured,
  onSend,
}: {
  permission: PermissionMode;
  configured: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="composer-zone">
      <div className="context-axis">
        <span className="ctx-label">权限档位</span>
        <span className={`ctx-chip${permission === "auto" ? " perm-auto" : ""}`}>
          <b>{PERM_LABEL[permission]}</b>
        </span>
        <span className="ctx-chip dashed" title="M0 占位：上下文裁剪随工作区能力一起到">✂ 上下文轴（即将上线）</span>
      </div>
      <div className="composer">
        <Avatar />
        <textarea
          rows={1}
          value={text}
          placeholder={
            configured
              ? "给风铃派活，或随便聊聊……（她干活时你也能打字）"
              : "先配置模型：点右上角 ⚙ 设置 Base URL / API Key / 模型"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="send" onClick={submit} title="发送">➤</button>
      </div>
      <div className="composer-hints">
        <span><code>@</code>文件</span>
        <span><code>#</code>知识库</span>
        <span><code>!</code>动作模板</span>
        <span style={{ marginLeft: "auto" }}>M0：直连你配置的端点，无遥测</span>
      </div>
    </div>
  );
}
