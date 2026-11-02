// M1-23：更新器 —— electron-updater 接入（generic feed）+ 状态机。
// 纪律（如实红线）：
//  - 开发环境（未打包）如实说"不可更新"，不假装检查成功；
//  - 未配置更新源时如实说"未配置"，不静默；
//  - Windows 签名未配置时不谎报"已签名"（签名要证书，属发布侧配置）；
//  - 自动下载关闭：有新版本先告知，用户确认再下载（update.download → update.install）。
// 回退口径：增量更新由 NSIS blockmap 差分下载承担；回退 = 从更新源重装旧版安装包（feed 按版本留存），
// electron-updater 不提供内置降级，不做虚假承诺。

import * as fs from "node:fs";
import * as path from "node:path";

export interface UpdateState {
  /** 是否可检查更新（打包 + 配置了 feed） */
  supported: boolean;
  /** 不可更新的原因（开发环境 / 未配置源） */
  reason?: string;
  feedUrl?: string;
  version: string;
  latest?: string;
  /** idle | available | downloading | downloaded | none */
  phase: "idle" | "available" | "downloading" | "downloaded" | "none";
  /** 0-100 */
  percent?: number;
  error?: string;
}

/** feed 解析：env 优先，其次 <dataRoot>/updater.json 的 { feedUrl }；都没有 → null */
export function resolveFeedUrl(env: NodeJS.ProcessEnv, dataRoot: string): string | null {
  const fromEnv = (env.LYNN_UPDATE_FEED ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, "updater.json"), "utf-8")) as { feedUrl?: string };
    const url = typeof raw.feedUrl === "string" ? raw.feedUrl.trim() : "";
    if (url) return url;
  } catch {
    /* 没配 */
  }
  return null;
}

/** 状态机迁移：非法迁移保持原状态（不谎报） */
export function transition(state: UpdateState, event: { type: string; [k: string]: unknown }): UpdateState {
  switch (event.type) {
    case "checking":
      return { ...state, phase: state.phase === "idle" ? "idle" : state.phase, error: undefined };
    case "available":
      return { ...state, phase: "available", latest: String(event.version ?? ""), percent: undefined, error: undefined };
    case "not-available":
      return { ...state, phase: "none", latest: undefined, percent: undefined, error: undefined };
    case "progress":
      if (state.phase !== "downloading") return state;
      return { ...state, percent: Math.max(0, Math.min(100, Number(event.percent ?? 0) || 0)) };
    case "downloaded":
      return { ...state, phase: "downloaded", percent: 100, error: undefined };
    case "error":
      return { ...state, error: String(event.message ?? "更新出错"), percent: undefined };
    default:
      return state;
  }
}
