// 多会话线程（M1-14）：一个线程 = 一段独立对话（feed + history + Pi 会话目录）。
// 落盘：`threads/index.json` 存索引，`threads/<id>.json` 存对话内容，Pi 会话在 `<id>/pi/`。
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeedCard } from "../shared/contract";
import { normalizeRoots, primaryOf, type RootSet } from "./roots";

export interface ThreadMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 会话的根集合（工作区模型，2026-11-10）：主根 + 附加只读/可写根。
   * 不同会话各带一套根，"审查 A 项目"和"整理 B 资料"不会互相串目录。
   */
  roots?: RootSet;
  /**
   * 主根的镜像（兼容旧代码/旧数据）：只读派生，改根时与 roots 一起同步。
   * 新代码请用 roots。
   */
  projectRoot?: string;
  /** 这个对话单独指定的模型；不设 = 跟随全局默认模型 */
  modelId?: string;
}

export interface ThreadState {
  feed: FeedCard[];
  history: { role: "user" | "assistant"; content: string }[];
  /** 会话累计用量（C4）：切回来时顶栏读数跟着会话走，不是一刀清零 */
  usage?: { sessionIn: number; sessionOut: number; cacheRead?: number; cacheWrite?: number; cost?: number; tokensUsed: number };
}

export class ThreadStore {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "threads");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private get indexFile(): string {
    return path.join(this.dir, "index.json");
  }

  list(): ThreadMeta[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf-8")) as { threads?: ThreadMeta[] };
      return Array.isArray(raw.threads) ? raw.threads : [];
    } catch {
      return [];
    }
  }

  private writeIndex(threads: ThreadMeta[]): void {
    fs.writeFileSync(this.indexFile, JSON.stringify({ threads }, null, 2), "utf-8");
  }

  get(id: string): ThreadMeta | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  /**
   * 建会话。roots 支持 RootSet（推荐）或旧的项目根字符串。
   * 不传 = 无根（由内核按默认工作区兜底，不在存储层猜）。
   */
  create(title?: string, roots?: RootSet | string): ThreadMeta {
    const at = new Date().toISOString();
    const normalized = typeof roots === "string" ? normalizeRoots({ primary: roots }) : normalizeRoots(roots);
    const meta: ThreadMeta = {
      id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: (title?.trim() || "新会话").slice(0, 40),
      createdAt: at,
      updatedAt: at,
      ...(normalized ? { roots: normalized } : {}),
      ...(primaryOf(normalized) ? { projectRoot: primaryOf(normalized) } : {}),
    };
    const threads = this.list();
    threads.unshift(meta);
    this.writeIndex(threads);
    this.saveState(meta.id, { feed: [], history: [] });
    fs.mkdirSync(this.piDir(meta.id), { recursive: true });
    return meta;
  }

  /** 改这个会话的根集合（主根镜像同步落盘，旧代码照常可读） */
  setRoots(id: string, roots: RootSet): ThreadMeta {
    const threads = this.list();
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error(`会话不存在：${id}`);
    const normalized = normalizeRoots(roots) ?? { extras: [] };
    t.roots = normalized;
    const primary = primaryOf(normalized);
    if (primary) t.projectRoot = primary;
    else delete t.projectRoot;
    t.updatedAt = new Date().toISOString();
    this.writeIndex(threads);
    return t;
  }

  /** 兼容旧入口：改主根（附加根保留） */
  setProject(id: string, projectRoot: string): ThreadMeta {
    const t = this.get(id);
    if (!t) throw new Error(`会话不存在：${id}`);
    const base = normalizeRoots(t.roots) ?? { extras: [] };
    return this.setRoots(id, { ...base, primary: path.resolve(projectRoot) });
  }

  /** 给这个对话单独指定模型；传 null = 跟随全局默认 */
  setModel(id: string, modelId: string | null): ThreadMeta {
    const threads = this.list();
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error(`会话不存在：${id}`);
    if (modelId) t.modelId = modelId;
    else delete t.modelId;
    t.updatedAt = new Date().toISOString();
    this.writeIndex(threads);
    return t;
  }

  rename(id: string, title: string): ThreadMeta {
    const threads = this.list();
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error(`会话不存在：${id}`);
    t.title = title.trim().slice(0, 40) || t.title;
    t.updatedAt = new Date().toISOString();
    this.writeIndex(threads);
    return t;
  }

  touch(id: string): void {
    const threads = this.list();
    const t = threads.find((x) => x.id === id);
    if (!t) return;
    t.updatedAt = new Date().toISOString();
    this.writeIndex(threads);
  }

  remove(id: string): void {
    this.writeIndex(this.list().filter((t) => t.id !== id));
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(this.piDir(id), { recursive: true, force: true });
  }

  stateFile(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  piDir(id: string): string {
    return path.join(this.dir, id, "pi");
  }

  saveState(id: string, state: ThreadState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile(id), JSON.stringify(state), "utf-8");
    this.touch(id);
  }

  loadState(id: string): ThreadState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile(id), "utf-8")) as ThreadState;
      return {
        feed: Array.isArray(raw.feed) ? raw.feed : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        usage: raw.usage,
      };
    } catch {
      return { feed: [], history: [] };
    }
  }

  /** 历史可搜：按关键词找会话，给上下文片段（每条 ≤60 字） */
  search(q: string, limit = 20): { id: string; title: string; hits: string[] }[] {
    const key = q.trim().toLowerCase();
    if (!key) return [];
    const out: { id: string; title: string; hits: string[] }[] = [];
    for (const t of this.list()) {
      const st = this.loadState(t.id);
      const hits: string[] = [];
      for (const c of st.feed) {
        const text = `${c.text ?? ""} ${c.title ?? ""} ${c.body ?? ""}`;
        if (text.toLowerCase().includes(key)) {
          const i = text.toLowerCase().indexOf(key);
          hits.push(text.slice(Math.max(0, i - 20), i + 40).trim());
          if (hits.length >= 3) break;
        }
      }
      if (!hits.length) {
        for (const h of st.history) {
          if (h.content.toLowerCase().includes(key)) {
            hits.push(h.content.slice(0, 60));
            if (hits.length >= 3) break;
          }
        }
      }
      if (hits.length) out.push({ id: t.id, title: t.title, hits });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 自动命名：首条用户消息前 20 字 */
  autoTitle(threadId: string, text: string): void {
    const t = this.get(threadId);
    if (!t || t.title !== "新会话") return;
    this.rename(threadId, text.trim().slice(0, 20) || "新会话");
  }
}
