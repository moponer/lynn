import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "../../shared/markdown";

/**
 * 聊天输出用的极简 Markdown 渲染（解析在 shared/markdown.ts）。
 * 只渲染白名单元素（p/h/ul/ol/blockquote/pre/hr/strong/code），不碰 innerHTML。
 */

function spans(list: MdInline[]): ReactNode[] {
  return list.map((s, i) => {
    if (s.t === "strong") return <strong key={i}>{s.v}</strong>;
    if (s.t === "code") return <code key={i}>{s.v}</code>;
    return <Fragment key={i}>{s.v}</Fragment>;
  });
}

function block(b: MdBlock, i: number): ReactNode {
  switch (b.t) {
    case "h": {
      if (b.level <= 1) return <h1 key={i}>{spans(b.spans)}</h1>;
      if (b.level === 2) return <h2 key={i}>{spans(b.spans)}</h2>;
      if (b.level === 3) return <h3 key={i}>{spans(b.spans)}</h3>;
      return <h4 key={i}>{spans(b.spans)}</h4>;
    }
    case "ul":
      return (
        <ul key={i}>
          {b.items.map((item, j) => (
            <li key={j}>{spans(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i}>
          {b.items.map((item, j) => (
            <li key={j}>{spans(item)}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote key={i}>{spans(b.spans)}</blockquote>;
    case "code":
      return (
        <pre key={i} className="md-code" data-lang={b.lang || undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case "hr":
      return <div key={i} className="md-hr" role="separator" />;
    default:
      return <p key={i}>{spans(b.spans)}</p>;
  }
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return <div className="md">{blocks.map(block)}</div>;
}
