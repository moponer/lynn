// 菜单基础件（2026-11-15）：一把尺子量所有弹出菜单。
//
// 统一的是四件在用户眼里算一件事的东西：
//   ① 位置——fixed + 视口夹取 + 下方不够就翻到光标上方（所有菜单都走同一个 hook）；
//   ② 收法——Esc、点外面、滚动/缩放（fixed 菜单不跟滚动走，位置一错就是坏体验）；
//   ③ 键盘——打开即聚焦第一项，↑/↓/Home/End 在项之间走，Enter/Space 激活；
//   ④ 分组——`.jobmenu-cap` 小节帽 + `.jobmenu-sep` 发丝线，危险项永远单独一段、排在最后。
//
// 这里只做外壳与行为；菜单里放什么由各业务组件决定（它们的数据与 RPC 不搬进来）。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * 菜单定位（2026-11-13）：默认在光标右下方展开；下方空间不够就翻到光标上方，
 * 否则菜单会溢出窗口底边、整块看不见。layout effect 在绘制前测量，无闪烁。
 */
export function useMenuPlacement(ref: RefObject<HTMLElement>, x: number, y: number, estW = 236, estH = 220) {
  // 初始坐标先夹一遍：首帧就不会画到屏幕外（之后按真实尺寸校正）
  const [style, setStyle] = useState(() => ({
    left: Math.max(8, Math.min(x, (window.innerWidth || 1200) - estW)),
    top: Math.max(8, Math.min(y, (window.innerHeight || 800) - estH)),
  }));
  useLayoutEffect(() => {
    const el = ref.current;
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    const w = el?.offsetWidth ?? estW;
    const h = el?.offsetHeight ?? estH;
    const above = y + h > vh - 8;
    const top = above ? Math.max(8, y - h) : Math.min(y, Math.max(8, vh - h - 8));
    const left = Math.max(8, Math.min(x, vw - w - 8));
    setStyle({ left, top });
  }, [x, y, ref, estW, estH]);
  return style;
}

/**
 * 菜单外壳。所有菜单都走它，于是"在哪儿关、怎么关、键盘怎么走"只有一份实现。
 * `className` 只用来加宽度/业务标记（如 `wsmenu`），surface 样式一律来自 `.jobmenu`。
 */
export function Menu({
  x,
  y,
  estW = 236,
  estH = 220,
  label,
  onClose,
  className,
  ignore,
  children,
}: {
  x: number;
  y: number;
  estW?: number;
  estH?: number;
  label?: string;
  onClose: () => void;
  className?: string;
  /** 触发按钮本身：点它由按钮自己 toggle，不该被"点外面"先关一次再被点开 */
  ignore?: RefObject<HTMLElement>;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const style = useMenuPlacement(box, x, y, estW, estH);

  // 点外面 / Esc / 滚动 / 缩放都收起来；fixed 菜单悬在错位的坐标上比关掉更糟
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (box.current?.contains(node) || ignore?.current?.contains(node)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, ignore]);

  // 打开即接管键盘：首项聚焦（不进滚动），关闭后把焦点还回去
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // 只在这张菜单挂载/卸载时跑：中途重渲染不该把焦点抢回第一项
    items()[0]?.focus({ preventScroll: true });
    return () => {
      if (prev && document.body.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  function items(): HTMLElement[] {
    return [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const list = items();
    if (!list.length) return;
    e.preventDefault();
    const at = list.findIndex((el) => el === document.activeElement);
    const last = list.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowDown"
            ? at < 0
              ? 0
              : (at + 1) % list.length
            : at <= 0
              ? last
              : at - 1;
    list[next]?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      className={`jobmenu${className ? ` ${className}` : ""}`}
      ref={box}
      style={style}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 小节帽：菜单里唯一允许的"组名"（等宽小字，和正文拉开一档） */
export function MenuCap({ children }: { children: ReactNode }) {
  return <div className="jobmenu-cap">{children}</div>;
}

/** 组间发丝线：危险段之前必须有它（靠间距与底色分层，不画描边） */
export function MenuSep() {
  return <div className="jobmenu-sep" role="separator" />;
}

/**
 * 菜单项。lead = 这一组的主动作（更亮的字色，不加底色不描边）；
 * danger = 不可恢复动作（seal 色，且调用方必须用 MenuSep 把它隔开）。
 */
export function MenuItem({
  icon,
  label,
  hint,
  lead,
  danger,
  disabled,
  trailing,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  lead?: boolean;
  danger?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`jobmenu-item${lead ? " lead" : ""}${danger ? " danger" : ""}`}
      disabled={disabled}
      title={hint}
      onClick={() => {
        if (disabled) return;
        onSelect();
      }}
    >
      {icon}
      <span className="jobmenu-label">{label}</span>
      {trailing}
    </button>
  );
}
