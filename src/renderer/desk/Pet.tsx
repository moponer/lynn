import { useEffect } from "react";
import { AvatarStage } from "./AvatarStage";
import { POSE_IMG, type PoseName } from "./pet-assets";

/**
 * 桌宠模式（P2）：独立透明置顶小窗里只有她。
 * 不抢电影；单击唤回主界面（主进程负责 show/focus 并关掉小窗）。
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
    <div className="pet" onClick={() => void window.lynn.rpc("pet.focus")} title="单击唤回风铃">
      <div className="pet-figure">
        <AvatarStage state="idle" mood={mood} minimal height={248} />
      </div>
      <div className="pet-hint">单击唤回</div>
    </div>
  );
}
