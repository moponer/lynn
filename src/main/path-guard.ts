import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 统一路径守卫（2026-11-13 审计 #1/#4/#10 收口）。
 *
 * 之前的守卫全是 `target.startsWith(base + path.sep)` 字符串前缀比较：
 * junction / 目录符号链接 / 8.3 短名（C:\PROGRA~1）可以让"字符串上在根内、
 * 实际指向根外"的路径通过。这里统一成 realpath 优先的 containment 判定，
 * 壳层所有路径分支（evidence.open / app.resolveRef / app.revealPath /
 * preview.read / preview.pdfWindow / app.openPath）只走这一个入口。
 */

/**
 * 目标已存在时两侧都走 realpath；不存在（尚未创建）时 realpath 最近已存在祖先，
 * 再把缺失的相对段拼回去。这样 root/link/new.txt 里的 link 指向根外也混不过去。
 */
export function insideBase(base: string, target: string): boolean {
  if (!base) return false;
  const realWithMissing = (p: string): string | null => {
    let current = path.resolve(p);
    const missing: string[] = [];
    let links = 0;
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return missing.length ? path.join(real, ...missing) : real;
      } catch {
        try {
          // realpath 对悬空链接也报 ENOENT；链接本身是已存在的，必须按 readlink 继续判，
          // 否则 root/dangling -> /outside/new.txt 会被当成"根内待创建文件"放行。
          if (fs.lstatSync(current).isSymbolicLink()) {
            if (++links > 40) return null;
            current = path.resolve(path.dirname(current), fs.readlinkSync(current));
            continue;
          }
        } catch {
          /* 普通的不存在路径段：向最近已存在祖先回退 */
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        missing.unshift(path.basename(current));
        current = parent;
      }
    }
  };
  const rb = realWithMissing(base);
  const rt = realWithMissing(target);
  if (!rb || !rt) return false;
  const rel = path.relative(rb, rt);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * app.openPath 的扩展名白名单（审计 #1）：黑名单天然漏（bat/cmd/ps1/vbs/js/exe/
 * com/scr/lnk/reg…），白名单只放文档/表格/演示/图片/音视频/压缩包/纯文本。
 * 数据根内有成员可写的目录，只挡"在数据根内"不够——能落地的可执行文件也不能放行。
 */
const OPENABLE_EXT = new Set([
  "pdf",
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xlsx",
  "xlsm",
  "docx",
  "docm",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "mp4",
  "webm",
  "zip",
]);

/** 返回拒绝原因；null = 放行。目录放行（导出包/日志目录语义）；白名单外一律拒。 */
export function openPathBlockReason(base: string, target: string): string | null {
  if (!insideBase(base, target)) return "只能打开风铃数据目录里的文件";
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return "文件不存在";
  }
  if (st.isDirectory()) return null;
  const ext = path.extname(target).replace(/^\./, "").toLowerCase();
  if (!ext || !OPENABLE_EXT.has(ext)) {
    return "这个类型的文件不在可打开白名单里（文档/图片/压缩包可以；可执行与脚本一律不行）";
  }
  return null;
}

/**
 * RPC 参数里的工单 id 校验（2026-11-13 审计 #17）：taskId 会被拼进路径
 * `path.resolve(dataRoot, "tasks", taskId)`——contains `..` 或绝对路径时，
 * **base 本身**就跳出了数据根，后面的 containment 判定（对着 base 比）形同虚设。
 * 内核生成的 id 是 `task-xxx` 形状，这里按字符集收口。
 */
export function taskIdError(taskId: unknown): string | null {
  const s = String(taskId ?? "").trim();
  if (!s) return "缺 taskId";
  if (s.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return "taskId 不合法，已拒绝";
  return null;
}
