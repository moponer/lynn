import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";

/**
 * 富文本底座（参考 tether-ai 的 FileDrawer）：
 *  - Markdown 用 react-markdown + remark-gfm（表格 / 任务列表 / 删除线 / 自动链接）；
 *  - 代码用 highlight.js/core + 按需注册语言（不联网、不拉 CDN、不启外部进程）；
 *  - 不开 rehype-raw：模型/文件里的 HTML 一律当文本，渲染层没有注入面。
 */

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript: javascript,
  typescript: typescript,
  json: json,
  xml: xml,
  css: css,
  python: python,
  rust: rust,
  bash: bash,
  yaml: yaml,
  markdown: markdown,
  sql: sql,
  go: go,
};
for (const [name, grammar] of Object.entries(LANGS)) hljs.registerLanguage(name, grammar);

/** 后缀 / 语言别名 → 已注册的语言名；认不出的按纯文本（绝不猜错语言乱上色） */
const ALIAS: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  json: "json", jsonc: "json", json5: "json",
  html: "xml", htm: "xml", svg: "xml", vue: "xml", xhtml: "xml",
  css: "css", scss: "css", less: "css",
  py: "python", ipynb: "json",
  rs: "rust", sh: "bash", bash: "bash", zsh: "bash", shell: "bash", ps1: "bash",
  yml: "yaml", yaml: "yaml", toml: "yaml", conf: "yaml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sql: "sql", go: "go",
  java: "javascript", c: "javascript", cpp: "javascript", h: "javascript", cs: "typescript",
};

export function langOf(extOrLang: string): string | undefined {
  const key = String(extOrLang || "").replace(/^\./, "").toLowerCase();
  if (!key) return undefined;
  if (LANGS[key]) return key;
  return ALIAS[key];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 生成已转义的高亮 HTML（highlight.js 自己转义，未注册语言走纯文本转义） */
export function highlightHtml(code: string, extOrLang?: string): string {
  const lang = langOf(extOrLang ?? "");
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** 源码视图：语言标签 + 行号 + 高亮；预览抽屉与 Markdown 代码块共用 */
export function HighlightedCode({
  code,
  lang,
  path,
  lineNumbers = true,
}: {
  code: string;
  lang?: string;
  path?: string;
  lineNumbers?: boolean;
}) {
  const html = useMemo(() => highlightHtml(code, lang || path || ""), [code, lang, path]);
  const lines = useMemo(() => html.split("\n"), [html]);
  const label = langOf(lang || path || "") ?? (path ? path.split(".").pop() : undefined);
  return (
    <div className="hl-code" data-lang={label || undefined}>
      {label && <span className="hl-lang mono">{label}</span>}
      <pre>
        <code>
          {lines.map((line, i) => (
            <span className="hl-line" key={i}>
              {lineNumbers && <i className="hl-no mono">{i + 1}</i>}
              <span dangerouslySetInnerHTML={{ __html: line || " " }} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

const COMPONENTS: Components = {
  a({ href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && /^https?:\/\//i.test(href)) void window.lynn.rpc("app.openExternal", { url: href });
        }}
      >
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const text = nodeText(children).replace(/\n$/, "");
    const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    if (lang || text.includes("\n")) {
      return (
        <div className="md-code-wrap">
          <HighlightedCode code={text} lang={lang} lineNumbers={false} />
        </div>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/** 流式输出的半截围栏先补齐，不然整段后半截会被当成代码 */
function closeFences(text: string): string {
  const fences = text.match(/^```/gm)?.length ?? 0;
  return fences % 2 ? `${text}\n\`\`\`` : text;
}

export const RichText = memo(function RichText({ text, streaming }: { text: string; streaming?: boolean }) {
  const source = streaming ? closeFences(String(text ?? "")) : String(text ?? "");
  if (!source.trim()) return null;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
