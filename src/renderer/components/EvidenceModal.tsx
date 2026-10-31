import type { Evidence } from "../../shared/contract";

/** 证据弹窗：证据必须可点开复跑，而不是引用块（§4.10.5 反作弊） */
export function EvidenceModal({
  evidence,
  onClose,
}: {
  evidence: Evidence | null;
  onClose: () => void;
}) {
  if (!evidence) return null;
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="evidence">
        <header>
          <b>{evidence.title}</b>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>任务 #0912 · 林工 · 14:32</span>
          <button className="x" onClick={onClose}>✕</button>
        </header>
        <pre className="term">{evidence.body}</pre>
        <footer>
          <span className="foot-note">证据是可复跑的真实对象，不是文字自述</span>
          <button className="btn">复跑</button>
          <button className="btn primary" onClick={onClose}>核对无误</button>
        </footer>
      </div>
    </div>
  );
}
