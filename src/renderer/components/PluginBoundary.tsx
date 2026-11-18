import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 插件级错误边界（2026-11-17 P9-1）。
 *
 * 为什么需要它，以及它和全局 `ErrorBoundary` 的分工：
 *
 *  - 全局 `ErrorBoundary` 保护的是**整个应用**：任何 render 期异常都会卸载整棵树，
 *    用户看到一块"界面崩了"。那是最后一道兜底，不该是插件的第一道。
 *  - 一个 UI 插件写错一行（`undefined.map`、读了不存在的字段），在**没有插件级边界**时
 *    会沿着组件树冒到顶层，把风铃整个界面换掉——**插件崩了，本体也崩了**。
 *    用户的要求是"有错误必须直接拦截显示出来，不能搞崩本体"，指的就是这件事。
 *
 * 所以每个插件渲染位都套一层：它崩了只留一个可读的错误卡（含插件 id 与错误摘要），
 * 旁边的界面照常工作。
 *
 * 两个刻意的设计：
 *  1. **错误卡要说清"是谁崩的"**：只写 "Something went wrong" 对排障毫无用处；
 *  2. **提供"停用这个插件"按钮**：崩了的插件用户第一反应是"怎么关掉它"，
 *     不该逼他去设置页翻三层。
 */
interface Props {
  /** 插件 id：错误卡上要显示"是谁崩的" */
  pluginId: string;
  /** 插件显示名（拿不到就用 id） */
  pluginName?: string;
  /** 停用回调；不传则不显示按钮（比如内置卡槽没有对应插件） */
  onDisable?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

export class PluginBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? "" });
    /**
     * 落盘但不抛出：日志通道自己也可能坏，二次崩会把整个界面带走。
     * 记 `pluginId` 是这条日志的关键——否则只知道"某个插件崩了"却不知道哪个。
     */
    try {
      window.lynn?.logError?.({
        kind: "react",
        message: `[${this.props.pluginId}] ${error.message}`,
        stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
      });
    } catch {
      /* 日志不可用也不能二次崩 */
    }
  }

  private reset = () => {
    this.setState({ error: null, componentStack: "" });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const name = this.props.pluginName || this.props.pluginId;
    return (
      <div className="plugin-error" role="alert">
        <div className="plugin-error-head">
          <b>插件「{name}」出错，已隔离</b>
          <small>{this.props.pluginId}</small>
        </div>
        <pre className="plugin-error-body">{this.state.error.message}</pre>
        <div className="plugin-error-actions">
          {/* 重试：多数渲染错误是数据形状不对，换了数据就好了，不该逼用户重装 */}
          <button type="button" className="sf-btn" onClick={this.reset}>
            重试
          </button>
          {this.props.onDisable && (
            <button
              type="button"
              className="sf-btn"
              onClick={() => {
                this.props.onDisable?.();
                this.reset();
              }}
            >
              停用这个插件
            </button>
          )}
        </div>
        <small className="plugin-error-note">
          其它界面不受影响；错误已记到 logs/renderer.log。
        </small>
      </div>
    );
  }
}