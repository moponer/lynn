import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 渲染层兜底（白屏可见化）。
 *
 * 没有边界时，任何 render 期异常都会让 React 卸载整棵树——用户看到的就是一块空窗口，
 * 而且没有任何现场。这里把错误变成一张能读的卡片：错误摘要 + 堆栈 + 重新载入按钮，
 * 同时通过 window.lynn.logError 落盘到 <数据根>/logs/renderer.log。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info?: string }> {
  state: { error: Error | null; info?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const detail = `${error.message}\n${info.componentStack ?? ""}`;
    this.setState({ info: detail });
    try {
      window.lynn?.logError?.({ kind: "react", message: error.message, stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}` });
    } catch {
      /* 日志通道不可用也不能二次崩 */
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: "var(--mono, monospace)", color: "var(--ink, #dfe6ee)", lineHeight: 1.7 }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>界面崩了（已记录到 logs/renderer.log）</h1>
        <p style={{ color: "var(--ink-2, #9aa7b4)", marginBottom: 16 }}>
          数据没有丢：会话、工单、团队档案都在磁盘上。点下面的按钮重新载入即可；反复出现请把这段文字发我。
        </p>
        <pre
          style={{
            padding: 16,
            background: "var(--panel, #141a21)",
            borderRadius: 8,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            maxHeight: "50vh",
            overflow: "auto",
          }}
        >
          {this.state.error.message}
          {this.state.info ? `\n${this.state.info}` : ""}
        </pre>
        <button type="button" className="ghost-btn" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
          重新载入
        </button>
      </div>
    );
  }
}
