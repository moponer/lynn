import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 项目身份（2026-11-12）。
 *
 * 以前"工作区"只是一串路径，界面上顶栏显示目录 basename，对话里谁都不知道
 * 这段对话到底在动哪个项目——风铃派单只能猜路径，成员回报也说不清项目。
 *
 * 现在把"目录"升格为"项目"：
 *  - 一个项目 = 一条记录（id + 显示名 + 主目录）
 *  - 同一个目录永远解析到同一个项目（按路径复用），所以「改过的名字跟着项目走」：
 *    改的是项目名，绑在它上面的所有群一起变
 *  - 群（会话）只保存 projectId；项目主目录仍是各群自己的 roots.primary（可覆盖）
 *
 * 落盘：`~/.lynn/projects.json`。
 */

export interface ProjectRecord {
  id: string;
  /** 显示名：默认取目录 basename，用户可改成中文名 */
  name: string;
  /** 项目主目录（绝对路径）；同路径复用判定键 */
  path: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_NAME = 40;

function abs(p: string): string {
  return path.resolve(String(p ?? "").trim());
}

/** 同路径判定：Windows 大小写不敏感 */
function samePath(a: string, b: string): boolean {
  const x = abs(a);
  const y = abs(b);
  if (!x || !y) return false;
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 默认显示名：目录 basename；盘符根取盘符；实在没有就用绝对路径尾段 */
export function defaultProjectName(p: string): string {
  const a = abs(p);
  if (!a) return "未命名项目";
  const parsed = path.parse(a);
  if (parsed.root === a) return `${parsed.root.replace(/[\\/]/g, "") || a} 盘`;
  const base = path.basename(a);
  return base || parsed.root.replace(/[\\/]/g, "") || a;
}

export class ProjectStore {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "projects.json");
  }

  list(): ProjectRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { projects?: ProjectRecord[] };
      if (!Array.isArray(raw.projects)) return [];
      return raw.projects.filter((p) => p && typeof p.id === "string" && typeof p.path === "string");
    } catch {
      return [];
    }
  }

  private write(projects: ProjectRecord[]): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ projects }, null, 2), "utf-8");
    } catch {
      /* 写不进去不影响本次会话：项目名退化成目录 basename */
    }
  }

  get(id: string): ProjectRecord | null {
    if (!id) return null;
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** 按路径找项目：找到就复用（名字沿用），没有就新建（名字 = basename） */
  ensureByPath(p: string): ProjectRecord {
    const target = abs(p);
    const projects = this.list();
    const found = projects.find((x) => samePath(x.path, target));
    if (found) return found;
    const now = new Date().toISOString();
    const rec: ProjectRecord = {
      id: `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: defaultProjectName(target),
      path: target,
      createdAt: now,
      updatedAt: now,
    };
    projects.push(rec);
    this.write(projects);
    return rec;
  }

  /** 改显示名（项目级：所有绑在它上面的群一起变） */
  rename(id: string, name: string): ProjectRecord | null {
    const projects = this.list();
    const rec = projects.find((p) => p.id === id);
    if (!rec) return null;
    const next = String(name ?? "").trim().slice(0, MAX_NAME);
    if (!next) return rec;
    rec.name = next;
    rec.updatedAt = new Date().toISOString();
    this.write(projects);
    return rec;
  }

  /** 项目 id → 记录；找不到返回 null（不猜） */
  resolve(id: string | undefined | null): ProjectRecord | null {
    if (!id) return null;
    return this.get(id);
  }
}
