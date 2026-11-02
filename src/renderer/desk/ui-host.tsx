import { useEffect, useRef, useState } from "react";
import { BUILTIN_UI_PLUGINS, enabledUiPlugins, pluginsForSlot, type UiPluginManifest, type UiSlot } from "../../shared/ui-plugin";

/**
 * U 插件宿主（计划书 §4.2.4）。
 *
 * - 官方受限组件：直接渲染在宿主里（受信）；
 * - 第三方：一律 iframe sandbox（allow-scripts，无 allow-same-origin、无外联），
 *   只通过 postMessage 与宿主通信，宿主校验 e.source 才收。
 * - 磁盘插件：主进程扫描 `~/.lynn/plugins/*`，只把校验过的 manifest + iframe 文档交给渲染层。
 */

export type UiPluginEntry = UiPluginManifest & { html?: string; fromDisk?: boolean };

const KEY_DISABLED = "lynn.ui.disabled";
const EVENT = "lynn:ui-plugins";

function readDisabled(): string[] {
  try {
    const raw = localStorage.getItem(KEY_DISABLED);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** 启停状态 + 磁盘插件（全局一份；设置面板改动后广播事件，顶栏/指令台即时生效） */
export function useUiPlugins(): {
  all: UiPluginEntry[];
  enabled: UiPluginEntry[];
  disabled: string[];
  errors: string[];
  toggle: (id: string) => void;
} {
  const [disabled, setDisabled] = useState<string[]>(readDisabled);
  const [disk, setDisk] = useState<UiPluginEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const on = () => setDisabled(readDisabled());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.lynn.rpc("ui.plugins");
        if (!alive || !r) return;
        const list = Array.isArray(r.plugins) ? r.plugins : [];
        setDisk(list.map((p) => ({ ...p, fromDisk: true })));
        setErrors(Array.isArray(r.errors) ? r.errors : []);
      } catch {
        // 没有内核（预览/测试）时只保留内置示例
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const builtin: UiPluginEntry[] = BUILTIN_UI_PLUGINS.map((p) => ({ ...p }));
  const seen = new Set(builtin.map((p) => p.id));
  const all = [...builtin, ...disk.filter((p) => !seen.has(p.id))];

  const toggle = (id: string) => {
    const next = readDisabled().includes(id) ? readDisabled().filter((x) => x !== id) : [...readDisabled(), id];
    localStorage.setItem(KEY_DISABLED, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
    setDisabled(next);
  };

  return {
    all,
    enabled: enabledUiPlugins(all, disabled),
    disabled,
    errors,
    toggle,
  };
}

/** 某个卡槽上的插件（按声明顺序） */
export function Slot({
  slot,
  render,
}: {
  slot: UiSlot;
  render: (p: UiPluginEntry) => React.ReactNode;
}) {
  const { enabled } = useUiPlugins();
  return <>{pluginsForSlot(enabled, slot).map((p) => render(p as UiPluginEntry))}</>;
}

/** 磁盘插件的 iframe 宿主：只下发颜色 Token，只收 action/resize */
export function SandboxHtml({
  plugin,
  width = 150,
  height = 32,
  onAction,
}: {
  plugin: UiPluginEntry;
  width?: number;
  height?: number;
  onAction?: (label: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { lynn?: boolean; type?: string; label?: string; height?: number };
      if (!d || d.lynn !== true) return;
      if (d.type === "action" && d.label && onAction) onAction(String(d.label).slice(0, 40));
      if (d.type === "resize" && d.height) {
        frame.current.style.height = `${Math.min(80, Math.max(20, d.height))}px`;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onAction]);

  return (
    <iframe
      ref={frame}
      title={plugin.name}
      sandbox="allow-scripts"
      srcDoc={plugin.html ?? ""}
      onLoad={() => {
        const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        frame.current?.contentWindow?.postMessage(
          { lynn: true, type: "init", plugin: plugin.id, theme: { desk: css("--desk"), sheet: css("--sheet-3"), ink: css("--ink") } },
          "*",
        );
      }}
      style={{ border: 0, width, height, background: "transparent", verticalAlign: "middle" }}
    />
  );
}

/** 内置第三方示例：iframe 里的按钮只发 postMessage，绝不碰宿主 DOM */
export function SandboxAction({
  plugin,
  onAction,
}: {
  plugin: UiPluginEntry;
  onAction: (label: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { lynn?: boolean; plugin?: string; type?: string; label?: string };
      if (!d || d.lynn !== true || d.plugin !== plugin.id) return;
      if (d.type === "action" && d.label) onAction(String(d.label).slice(0, 40));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [plugin.id, onAction]);

  // 磁盘插件用自己的 iframe 文档；内置示例用下面的最小文档
  if (plugin.html) return <SandboxHtml plugin={plugin} width={128} height={32} onAction={onAction} />;

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html,body{margin:0;background:transparent;font:12px/1.4 "Segoe UI","PingFang SC",sans-serif;overflow:hidden}
  button{border:0;border-radius:5px;padding:6px 10px;cursor:pointer;background:#2a3745;color:#e4eaef;font:inherit}
  button:hover{filter:brightness(1.1)}
</style></head><body>
<button id="b" title="示例第三方 UI 插件">⏱ 专注 25 分钟</button>
<script>
  const b = document.getElementById('b');
  const send = (m) => parent.postMessage(Object.assign({ lynn: true, plugin: ${JSON.stringify(plugin.id)} }, m), '*');
  b.addEventListener('click', () => send({ type: 'action', label: '专注 25 分钟' }));
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'init' || !d.theme) return;
    if (typeof d.theme.desk === 'string') document.body.style.background = d.theme.desk;
    if (typeof d.theme.sheet === 'string') b.style.background = d.theme.sheet;
    if (typeof d.theme.ink === 'string') b.style.color = d.theme.ink;
  });
  send({ type: 'resize', height: 32 });
</script></body></html>`;

  return (
    <iframe
      ref={frame}
      title={plugin.name}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      onLoad={() => {
        const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        frame.current?.contentWindow?.postMessage(
          { lynn: true, plugin: plugin.id, type: "init", theme: { desk: css("--desk"), sheet: css("--sheet-3"), ink: css("--ink") } },
          "*",
        );
      }}
      style={{ border: 0, width: 128, height: 32, background: "transparent", verticalAlign: "middle" }}
    />
  );
}
