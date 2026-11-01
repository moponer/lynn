import { useState } from "react";
import type { ModelConfigView } from "../../shared/contract";

/** 配置界面：Base URL / API Key / 模型，可测通；Key 用 safeStorage 加密落盘 */
export function SettingsModal({
  current,
  onClose,
  onSaved,
}: {
  current: ModelConfigView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(current.provider || "DeepSeek");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl || "https://api.deepseek.com/v1");
  const [model, setModel] = useState(current.model || "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const keyPlaceholder = current.apiKeySet ? "已保存（留空则沿用）" : "sk-…";

  const save = async () => {
    setBusy("save");
    setResult(null);
    try {
      await window.lynn.rpc("config.save", {
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setResult({ ok: true, text: "已保存。" });
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };

  const testConn = async () => {
    setBusy("test");
    setResult(null);
    try {
      const r = await window.lynn.rpc("config.test", {
        baseUrl: baseUrl.trim(),
        // 测试用当前输入的 Key；没输入且已存过则用输入框占位会被后端拒绝——
        // 这里直接要求用户先粘贴 Key 再点测试，避免明文回传
        apiKey: apiKey.trim(),
        model: model.trim(),
      });
      setResult(
        r.ok
          ? { ok: true, text: `连通正常，延迟 ${r.latencyMs}ms` }
          : { ok: false, text: r.error },
      );
    } finally {
      setBusy("");
    }
  };

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="cfg-field">
      <span className="cfg-label">{label}</span>
      {node}
      {hint && <small className="cfg-hint">{hint}</small>}
    </label>
  );

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="evidence cfg">
        <header>
          <b>模型配置</b>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            OpenAI 兼容端点 · DeepSeek / GLM / Kimi / Qwen / Ollama… · Key 加密存在本机
          </span>
          <button className="x" onClick={onClose}>✕</button>
        </header>
        <div className="cfg-body">
          {field(
            "服务商名称",
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="DeepSeek / 智谱 / 月之暗面…" />,
          )}
          {field(
            "Base URL",
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />,
            "OpenAI 兼容地址，不带 /chat/completions",
          )}
          {field(
            "API Key",
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyPlaceholder}
            />,
            current.apiKeySet ? "已加密保存；换 Key 时才需要填" : "只存在你的电脑上（safeStorage 加密）",
          )}
          {field("模型", <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />)}
        </div>
        {result && (
          <div className={`cfg-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>
        )}
        <footer>
          <span className="foot-note">直连你配置的端点，无中转、无遥测</span>
          <button className="btn" onClick={testConn} disabled={busy !== "" || !apiKey.trim()}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button className="btn primary" onClick={save} disabled={busy !== ""}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
