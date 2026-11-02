// M1-16：本轮随附 —— 文件内容注入 + 图片落盘（隐私承诺的界面化：
// 发送前用户看得见每一片，可逐片裁剪；这里只负责把「带上的东西」如实组装进消息）
import * as fs from "node:fs";
import * as path from "node:path";

export interface TurnAttachments {
  files?: string[];
  images?: { name: string; data: string }[];
}

export interface AttachmentPiece {
  kind: "file" | "image";
  label: string;
}

export interface AttachmentResult {
  /** 原文 + 附块：发给模型、进 history */
  fullText: string;
  /** 成功带上的一览（卡片 meta 用） */
  pieces: AttachmentPiece[];
  /** 没带上的及原因（如实报，不静默丢） */
  errors: string[];
  /** 图片落盘的绝对路径 */
  savedImages: string[];
}

/** 单文件注入上限：超出截断并注明（不静默吞） */
export const MAX_FILE_BYTES = 256 * 1024;
/** 图片落盘上限（base64 解码后） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function buildTurnAttachments(
  projectRoot: string,
  dataRoot: string,
  text: string,
  att: TurnAttachments,
): AttachmentResult {
  const pieces: AttachmentPiece[] = [];
  const errors: string[] = [];
  const savedImages: string[] = [];
  const blocks: string[] = [];

  const rootResolved = path.resolve(projectRoot);
  for (const rel of att.files ?? []) {
    const label = rel.trim();
    if (!label) continue;
    const full = path.resolve(rootResolved, label);
    if (!full.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep)) {
      errors.push(`${label}（不在项目工作区内）`);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        errors.push(`${label}（不是文件）`);
        continue;
      }
      let content = fs.readFileSync(full, "utf-8");
      if (stat.size > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES);
        blocks.push(`▸ 文件 ${label}（超过 256KB，只带了前 256KB）：\n${content}`);
      } else {
        blocks.push(`▸ 文件 ${label}：\n${content}`);
      }
      pieces.push({ kind: "file", label });
    } catch {
      errors.push(`${label}（读不到）`);
    }
  }

  if ((att.images?.length ?? 0) > 0) {
    const dir = path.join(dataRoot, "attachments", `turn-${Date.now().toString(36)}`);
    fs.mkdirSync(dir, { recursive: true });
    att.images!.forEach((img, i) => {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(img.data ?? "");
      if (!m) {
        errors.push(`${img.name || `图片${i + 1}`}（不是可识别的图片数据）`);
        return;
      }
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > MAX_IMAGE_BYTES) {
        errors.push(`${img.name || `图片${i + 1}`}（超过 8MB 上限）`);
        return;
      }
      const ext = m[1] === "image/jpeg" ? ".jpg" : m[1] === "image/webp" ? ".webp" : m[1] === "image/gif" ? ".gif" : ".png";
      const safe = (img.name || `图片${i + 1}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || `图片${i + 1}`;
      const file = path.join(dir, `${i + 1}-${safe}${ext}`);
      fs.writeFileSync(file, buf);
      savedImages.push(file);
      blocks.push(`▸ 图片 ${safe}：已保存到 ${file}（如具备读图能力，可用 read_file 查看）`);
      pieces.push({ kind: "image", label: safe });
    });
  }

  const fullText = blocks.length ? `${text}\n\n【本轮随附】\n${blocks.join("\n\n")}` : text;
  return { fullText, pieces, errors, savedImages };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".lynn", ".next", "coverage"]);
const WALK_MAX_FILES = 5000;
const WALK_MAX_DEPTH = 5;

/** 项目工作区文件检索（@ 提及补全用）：相对路径 + 大小 */
export function searchProjectFiles(
  projectRoot: string,
  q: string,
  limit = 20,
): { path: string; size: number }[] {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const key = q.trim().toLowerCase();
  const all: { path: string; size: number }[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (all.length >= WALK_MAX_FILES || depth > WALK_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (all.length >= WALK_MAX_FILES) return;
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), rp, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          /* 取不到大小就当 0 */
        }
        all.push({ path: rp, size });
      }
    }
  };
  walk(root, "", 0);
  const hit = key ? all.filter((f) => f.path.toLowerCase().includes(key)) : all;
  return hit.slice(0, limit);
}
