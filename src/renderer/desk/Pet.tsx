import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { KernelEvent } from "../../shared/contract";
import type { AvatarState } from "../../shared/avatar";
import { PetStage } from "./PetStage";
import { POSE_IMG, type PoseName } from "./pet-assets";

/**
 * 桌宠模式（P2）：独立透明置顶小窗里只有她。
 *
 * 窗体可拖动（CSS -webkit-app-region: drag 交给系统移动），不再"点一下就关 / 拖一下转没"。
 * 右上角「收起」单独关窗（no-drag，不影响拖动）。
 *
 * 状态不再写死 idle：监听内核事件流（全窗口广播），把 delta/turn/done/error/card
 * 映射成 6 档运行态，交给 PetStage 的动画链表表达。短结果态（成功/失败）几秒后回落 idle。
 */

/** 内核事件 → 形象运行态；返回 null 表示这次不改变状态 */
function eventToState(ev: KernelEvent): AvatarState | null {
  switch (ev.type) {
    case "delta":
      return ev.thinking ? "thinking" : "running";
    case "tool":
    case "card":
      return "running";
    case "turn": {
      if (!ev.turn.busy) return "idle";
      return ev.turn.activity === "model" ? "thinking" : "running";
    }
    case "done":
      return "success";
    case "error":
      return "failed";
    default:
      return null;
  }
}

const TRANSIENT_MS = 2600;

export function Pet() {
  const t = useT();
  const [state, setState] = useState<AvatarState>("idle");
  const resetTimer = useRef<number | null>(null);
  /** 结果态保护窗：done 之后内核常紧跟着发 turn(busy=false)，别让「搞定啦」被秒冲掉 */
  const holdUntil = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.pet = "1";
    return () => {
      delete document.documentElement.dataset.pet;
    };
  }, []);

  useEffect(() => {
    const off = window.lynn.onEvent((ev: KernelEvent) => {
      const next = eventToState(ev);
      if (!next) return;
      // 结果态展示窗内的 idle 回落事件一律忽略（内核 done 后常紧跟 turn idle）
      if (next === "idle" && Date.now() < holdUntil.current) return;
      setState(next);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
      if (next === "success" || next === "failed" || next === "waiting_confirm") {
        holdUntil.current = Date.now() + TRANSIENT_MS;
        resetTimer.current = window.setTimeout(() => {
          setState("idle");
          resetTimer.current = null;
        }, TRANSIENT_MS);
      }
    });
    return () => {
      off();
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  // 仅走查用：?pet=1&mood=sleep 可强制指定任一姿态；生产桌宠窗不带 mood，跑动画链
  const moodParam = new URLSearchParams(location.search).get("mood");
  const mood = moodParam && moodParam in POSE_IMG.front ? (moodParam as PoseName) : undefined;

  return (
    <div className="pet">
      <button
        type="button"
        className="pet-close"
        title={t("look.petClose")}
        onClick={(e) => {
          e.stopPropagation();
          void window.lynn.rpc("pet.close");
        }}
      >
        ×
      </button>
      <div className="pet-figure">
        <PetStage state={state} mood={mood} height={388} />
      </div>
    </div>
  );
}
