// 确认卡片（2026-11-15）：所有"做了就回不去"的动作共用一张卡。
//
// 之前的三种形态各说各话——群列表里一行小字配两个小按钮、归档行按钮自己变红字、
// 交付箱在菜单里换一页再弹系统 window.confirm。用户看到的是三套东西。
//
// 这张卡统一四件事：
//   ① 层级——标题（做什么）→ 说明（影响谁）→ 警示（不可恢复）→ 按钮（取消在左，确认在右）；
//   ② 语气——危险动作整卡走 danger 语气（图标底与确认按钮用 seal 色），普通动作走默认；
//   ③ 位置——取消永远最左、弱样式；确认永远最右、强样式，多选一时强的那一项在最右；
//   ④ 收法——Esc / 点遮罩 = 取消（危险动作默认聚焦"取消"，别让回车误伤）。
//
// 用法：React 侧 <AskHost/> 挂在应用根部；任何地方 `await askConfirm({...})` 即可，
// 不需要把确认状态一层层往上传（App / 设置页的 window.confirm 也换成了它）。
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { useT } from "../i18n";

export type AskAction = {
  label: string;
  value: string;
  /** primary = 主操作（蓝）；danger = 不可恢复（seal）；ghost = 次要出口 */
  tone?: "primary" | "danger" | "ghost";
};

export type AskSpec = {
  /** 一句话说清要做什么（"删除群「周报整理」"），不是问句堆叠 */
  title: string;
  /** 影响范围：谁会没、什么会留 */
  body?: string;
  /** 不可恢复的提醒，单独一条红底块 */
  note?: string;
  icon?: IconName;
  danger?: boolean;
  cancelLabel?: string;
  actions: AskAction[];
};

type Handler = (spec: AskSpec) => Promise<string | null>;
let handler: Handler | null = null;
/** 串行队列：同一时刻只开一张卡，后来的排队（避免两张遮罩叠在一起收不掉） */
let queue: Promise<unknown> = Promise.resolve();

export function ask(spec: AskSpec): Promise<string | null> {
  const run = queue.then(() => {
    if (handler) return handler(spec);
    // 没有宿主（例如单测环境）时退回系统确认，至少不会静默执行危险动作
    if (spec.actions.length === 1) {
      const text = [spec.title, spec.body, spec.note].filter(Boolean).join("\n\n");
      return Promise.resolve(window.confirm(text) ? spec.actions[0].value : null);
    }
    return Promise.resolve<string | null>(null);
  });
  queue = run.catch(() => undefined);
  return run;
}

/** 是 / 否：确认返回 true，取消或关掉返回 false */
export async function askConfirm(o: Omit<AskSpec, "actions"> & { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  const value = await ask({
    ...o,
    actions: [{ label: o.confirmLabel ?? "确定", value: "ok", tone: o.danger ? "danger" : "primary" }],
  });
  return value === "ok";
}

/** 挂在应用根部一次即可 */
export function AskHost() {
  const [spec, setSpec] = useState<AskSpec | null>(null);
  const done = useRef<((v: string | null) => void) | null>(null);
  useEffect(() => {
    handler = (s) =>
      new Promise<string | null>((resolve) => {
        done.current = resolve;
        setSpec(s);
      });
    return () => {
      handler = null;
    };
  }, []);
  const finish = (value: string | null) => {
    const resolve = done.current;
    done.current = null;
    setSpec(null);
    resolve?.(value);
  };
  return spec ? <ConfirmCard spec={spec} onDone={finish} /> : null;
}

/** 卡片本体：也可以在别处直接内联渲染（不必经过 ask） */
export function ConfirmCard({ spec, onDone }: { spec: AskSpec; onDone: (value: string | null) => void }) {
  const t = useT();
  const card = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const danger = spec.danger ?? spec.actions.some((a) => a.tone === "danger");

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const buttons = [...(card.current?.querySelectorAll<HTMLElement>(".ask-acts button") ?? [])];
    // 危险动作默认落在"取消"上：回车不该替用户按下删除
    (danger ? cancelRef.current ?? buttons[0] : buttons[buttons.length - 1])?.focus({ preventScroll: true });
    return () => {
      if (prev && document.body.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [danger]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDone(null);
      return;
    }
    if (e.key !== "Tab") return;
    const buttons = [...(card.current?.querySelectorAll<HTMLElement>(".ask-acts button") ?? [])];
    if (buttons.length < 2) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && at <= 0) {
      e.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (!e.shiftKey && at === buttons.length - 1) {
      e.preventDefault();
      buttons[0].focus();
    }
  };

  return createPortal(
    <div
      className="ask-overlay"
      // 点遮罩 = 取消；点卡片内部不穿（用 target 判定，不靠 stopPropagation 影响子元素点击）
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(null);
      }}
    >
      <div
        className="ask-card"
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        data-tone={danger ? "danger" : "default"}
        onKeyDown={onKeyDown}
      >
        <div className="ask-hd">
          <span className="ask-ic" aria-hidden>
            <Icon name={spec.icon ?? (danger ? "warn" : "info")} />
          </span>
          <div className="ask-ht">
            <h2 className="ask-title">{spec.title}</h2>
            {spec.body && <p className="ask-body">{spec.body}</p>}
          </div>
        </div>
        {spec.note && (
          <div className="ask-note">
            <Icon name="warn" size="sm" />
            <span>{spec.note}</span>
          </div>
        )}
        <div className="ask-acts">
          <button type="button" ref={cancelRef} className="ask-btn ghost" onClick={() => onDone(null)}>
            {spec.cancelLabel ?? t("common.cancel")}
          </button>
          {spec.actions.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`ask-btn ${a.tone ?? "primary"}`}
              onClick={() => onDone(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
