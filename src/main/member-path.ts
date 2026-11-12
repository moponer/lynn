// 成员常把 Windows 绝对路径写成伪 POSIX 形式 `/F:/repo/x`（模型习惯）。
// path.resolve(base, "/F:/repo/x") 在 Windows 会变成 `C:\F:\repo\x`，与已授权根
// `F:\repo` 对不上 → 明明用户已经批准只读授权，read_file 却报「路径越界」。
// 2026-11-11 长任务实测：成员回报「路径越界：/F:/spiker/hermix-desktop/package.json
// … 已授权只读：F:\spiker\hermix-desktop」，主风铃据此误判为"等授权"，连重派 20+ 次。
import * as path from "node:path";

const LEADING_SLASH_WIN = /^[/\\]+([A-Za-z]:[\\/].*)$/;

/** 归一模型写歪的绝对路径；相对路径原样交给 path.resolve。 */
export function normalizeTargetPath(base: string, target: string): string {
  const raw = String(target ?? "").trim();
  const m = LEADING_SLASH_WIN.exec(raw);
  const cleaned = m ? m[1] : raw;
  return path.resolve(path.resolve(base), cleaned);
}
