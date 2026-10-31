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
  onSend,
}: {
  permission: PermissionMode;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const sending = text.trim().length > 0;

  const submit = () => {
    if (!sending) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="composer-zone">
      <div className="inner-voice">（先核一下对账差的那 2 笔……）</div>
      <div className="context-axis">
        <span className="ctx-label">本轮将携带</span>
        <span className="ctx-chip">
          📎 <b>月报大纲.md</b>
        </span>
        <span className="ctx-chip">
          📚 <b>9月数据底稿</b> <small>知识库</small>
        </span>
        <span className="ctx-chip">
          🛠 工具 <b>6</b>/23
        </span>
        <span className={`ctx-chip${permission === "auto" ? " perm-auto" : ""}`}>
          权限 <b>{PERM_LABEL[permission]}</b>
        </span>
        <span className="ctx-chip dashed" title="点开裁剪">✂ 裁剪</span>
      </div>
      <div className="composer">
        <Avatar />
        <textarea
          rows={1}
          value={text}
          placeholder="给风铃派活，或随便聊聊……（排队输入：她干活时你也能打字）"
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
        <span style={{ marginLeft: "auto" }}>队列 0 · 切换线程即清空</span>
      </div>
    </div>
  );
}
