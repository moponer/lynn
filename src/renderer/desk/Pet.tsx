import { useEffect } from "react";
import { AvatarStage } from "./AvatarStage";
import { POSE_IMG, type PoseName } from "./pet-assets";

/**
 * 桌宠模式（P2）：独立透明置顶小窗里只有她。
 * 窗体可拖动（CSS -webkit-app-region: drag 交给系统移动），不再"点一下就关 / 拖一下转没"。
 * 右上角「收起」单独关窗（no-drag，不影响拖动）。
 */
export function Pet() {
  useEffect(() => {
    document.documentElement.dataset.pet = "1";
    return () => {
      delete document.documentElement.dataset.pet;
    };
  }, []);

  // 仅走查用：?pet=1&mood=sleep 可强制指定任一姿态；生产桌宠窗不带 mood，回落 idle 眨眼
  const moodParam = new URLSearchParams(location.search).get("mood");
  const mood = moodParam && moodParam in POSE_IMG ? (moodParam as PoseName) : undefined;

  return (
    <div className="pet">
      <button
        type="button"
        className="pet-close"
        title="收起桌宠"
        onClick={(e) => {
          e.stopPropagation();
          void window.lynn.rpc("pet.close");
        }}
      >
        ×
      </button>
      <div className="pet-figure">
        <AvatarStage state="idle" mood={mood} minimal height={388} />
      </div>
    </div>
  );
}
