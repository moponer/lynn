// M2-01：本地日历 + 待办 + 提醒（§3.4 L300）。
//  - 存储：node:sqlite（Electron 主进程自带）；打不开时降级 JSON 文件，backend 如实标注。
//  - 录入：自然语言"下周三下午三点提醒我整理周报"——纯函数解析，识别不了如实说，不猜。
//  - 提醒：dueReminders(now) 纯函数判定到期未提醒的事件；调度循环由 kernel 挂（M2-02 cron 之前先分钟级扫描）。
import * as fs from "node:fs";
import * as path from "node:path";

// ---------- 自然语言时间解析（纯函数，可测） ----------

export interface ParsedWhen {
  at: Date;
  /** 命中的时间词（回显给用户核对） */
  matched: string;
  /** 去掉时间词后的剩余文本（即事情本身） */
  rest: string;
  /** 只给了日期没给时刻时注明默认 09:00 */
  defaultedTime: boolean;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 时刻词 → {h, m}；识别不了返回 null */
function parseClock(s: string): { h: number; m: number } | null {
  let m = /^(\d{1,2})点(\d{1,2})分$/.exec(s) ?? /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return { h: +m[1], m: +m[2] };
  m = /^(\d{1,2})点半$/.exec(s);
  if (m) return { h: +m[1], m: 30 };
  m = /^(\d{1,2})点$/.exec(s);
  if (m) return { h: +m[1], m: 0 };
  m = /^(\d{1,2})分$/.exec(s);
  if (m) return { h: -1, m: +m[1] }; // 只有分没有点：不成立，由调用方处理
  return null;
}

/** 把 {h,m} 按上午/下午/晚上/中午修饰校正成 24 小时制 */
function applyMeridiem(h: number, meridiem: string): number {
  if (meridiem === "" || meridiem === "上午" || meridiem === "早上" || meridiem === "清晨") return h;
  if (meridiem === "中午") return h === 12 ? 12 : h;
  if (meridiem === "凌晨") return h === 12 ? 0 : h;
  // 下午/晚上/傍晚：1-11 加 12；本身 12 保持；0 不动
  if (h >= 1 && h <= 11) return h + 12;
  return h;
}

function atTime(day: Date, h: number, m: number): Date {
  const x = startOfDay(day);
  x.setHours(h, m, 0, 0);
  return x;
}

/**
 * 解析"下周三下午三点整理周报"类文本。
 * 识别不了时间返回 null（调用方如实告知，不硬猜）。
 */
export function parseNaturalDate(text: string, now: Date = new Date()): ParsedWhen | null {
  const t = text.trim();
  if (!t) return null;
  const base = startOfDay(now);

  // 相对：N分钟/小时/天 之前/前/之后/后（中文数字也认："两小时后"）
  let m = /([〇零一二两三四五六七八九十]+|\d+(?:\.\d+)?)\s*(分钟|小时|天)\s*(之前|以前|前|之后|以后|后)/.exec(t);
  if (m) {
    const nRaw = m[1] === "半" ? 0.5 : /^\d/.test(m[1]) ? Number(m[1]) : (cnToInt(m[1]) ?? NaN);
    if (Number.isFinite(nRaw)) {
      const past = /前/.test(m[3]);
      const n = nRaw * (past ? -1 : 1);
      const ms = m[2] === "分钟" ? n * 60_000 : m[2] === "小时" ? n * 3_600_000 : n * 86_400_000;
      const at = new Date(now.getTime() + ms);
      return { at, matched: m[0], rest: t.replace(m[0], "").trim(), defaultedTime: false };
    }
  }

  // 今天/明天/后天/大后天
  m = /(今天|今日|明天|明日|后天|大后天)/.exec(t);
  if (m) {
    const day = new Date(base);
    if (m[1] === "明天" || m[1] === "明日") day.setDate(day.getDate() + 1);
    else if (m[1] === "后天") day.setDate(day.getDate() + 2);
    else if (m[1] === "大后天") day.setDate(day.getDate() + 3);
    return finishDay(t, m[0], day);
  }

  // (下周|本周|星期|周)X —— 先于"X月X日"无冲突
  m = /(下下周|下周|本周|这周|下星期|星期|周)([一二三四五六日天])/.exec(t);
  if (m) {
    const target = WEEK.indexOf(m[2] === "天" ? "日" : m[2]);
    const day = new Date(base);
    const toTarget = (offsetWeeks: number): number => {
      // 本周内到目标星期几的天数（0=今天），再加整周偏移
      return ((target - day.getDay() + 7) % 7) + offsetWeeks * 7;
    };
    let delta: number;
    if (m[1].startsWith("下下周")) delta = toTarget(2);
    else if (m[1].startsWith("下周") || m[1].startsWith("下星期")) delta = toTarget(1);
    else if (m[1] === "本周" || m[1] === "这周") delta = toTarget(0);
    else delta = toTarget(0); // 裸"周X/星期X"：未来最近（含今天）
    day.setDate(day.getDate() + delta);
    return finishDay(t, m[0], day);
  }

  // X月X日/号（含明年；过去的月份顺延一年）
  m = /(\d{1,2})月(\d{1,2})[日号]/.exec(t);
  if (m) {
    const month = +m[1] - 1;
    const date = +m[2];
    const day = new Date(base.getFullYear(), month, date);
    if (day < base) day.setFullYear(day.getFullYear() + 1);
    return finishDay(t, m[0], day);
  }

  return null;
}

/** 中文数字（〇零一二两三四五六七八九十）→ 整数；支持到九十九 */
function cnToInt(s: string): number | null {
  const digit: Record<string, number> = { "〇": 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d{1,2}$/.test(s)) return +s;
  if (s === "十") return 10;
  const m = /^([〇零一二两三四五六七八九]?)十([〇零一二两三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? digit[m[1]] : 1) * 10 + (m[2] ? digit[m[2]] : 0);
  if (s.length === 1 && digit[s] !== undefined) return digit[s];
  return null;
}

/** 日期词命中后，再从剩余文本里找时刻词（阿拉伯或中文数字）；找不到默认 09:00 */
function finishDay(text: string, matchedDay: string, day: Date): ParsedWhen {
  const rest = text.replace(matchedDay, "").trim();
  // 先试阿拉伯数字形式（含 HH:MM）
  let cm = /([上下]?午|凌晨|中午|晚上|傍晚)?\s*(\d{1,2}点(?:\d{1,2}分|半)?|\d{1,2}:\d{2})/.exec(rest);
  if (cm) {
    const clock = parseClock(cm[2]);
    if (clock && clock.h >= 0) {
      const h = applyMeridiem(clock.h, cm[1] ?? "");
      const at = atTime(day, Math.min(h, 23), Math.min(clock.m, 59));
      return { at, matched: matchedDay + cm[0].trim(), rest: (rest.slice(0, cm.index) + rest.slice(cm.index + cm[0].length)).trim(), defaultedTime: false };
    }
  }
  // 中文数字形式：下午三点 / 上午十点二十(分) / 九点半
  cm = /([上下]?午|凌晨|中午|晚上|傍晚)?\s*([〇零一二两三四五六七八九十]{1,3})点(半|([〇零一二两三四五六七八九十]{1,2})分?)?/.exec(rest);
  if (cm) {
    const hRaw = cnToInt(cm[2]);
    const mRaw = cm[3] === "半" ? 30 : cm[4] ? (cnToInt(cm[4]) ?? 0) : 0;
    if (hRaw !== null) {
      const h = applyMeridiem(hRaw, cm[1] ?? "");
      const at = atTime(day, Math.min(h, 23), Math.min(mRaw, 59));
      return { at, matched: matchedDay + cm[0].trim(), rest: (rest.slice(0, cm.index) + rest.slice(cm.index + cm[0].length)).trim(), defaultedTime: false };
    }
  }
  return { at: atTime(day, 9, 0), matched: matchedDay, rest, defaultedTime: true };
}

// ---------- 存储 ----------

export interface CalEvent {
  id: number;
  title: string;
  at: string; // ISO
  /** 提前提醒分钟数；0 = 到点提醒 */
  remindLead: number;
  notified: number; // 0/1
  status: "open" | "done" | "canceled";
  createdAt: string;
}

export interface TodoItem {
  id: number;
  text: string;
  due?: string; // ISO，可空
  done: number; // 0/1
  createdAt: string;
}

/** 到期该提醒而未提醒的事件（纯判定） */
export function dueReminders(events: CalEvent[], now: Date = new Date()): CalEvent[] {
  const t = now.getTime();
  return events.filter(
    (e) => e.status === "open" && !e.notified && t >= new Date(e.at).getTime() - e.remindLead * 60_000,
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  at TEXT NOT NULL,
  remind_lead INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

export class CalendarStore {
  /** sqlite | json（降级）——如实标注 */
  readonly backend: "sqlite" | "json";
  private db: unknown;
  private jsonFile: string;
  private data: { events: CalEvent[]; todos: TodoItem[]; seq: number } = { events: [], todos: [], seq: 0 };

  constructor(dataRoot: string) {
    this.jsonFile = path.join(dataRoot, "calendar.json");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
      const db = new DatabaseSync(path.join(dataRoot, "calendar.db"));
      (db as { exec: (s: string) => void }).exec(SCHEMA);
      this.db = db;
      this.backend = "sqlite";
    } catch {
      this.backend = "json";
      try {
        this.data = JSON.parse(fs.readFileSync(this.jsonFile, "utf-8"));
      } catch {
        this.data = { events: [], todos: [], seq: 0 };
      }
    }
  }

  private run(sql: string, ...args: unknown[]): void {
    (this.db as { prepare: (s: string) => { run: (...a: unknown[]) => void } }).prepare(sql).run(...args);
  }

  private all<T>(sql: string): T[] {
    return (this.db as { prepare: (s: string) => { all: () => T[] } }).prepare(sql).all() as T[];
  }

  private persistJson(): void {
    fs.mkdirSync(path.dirname(this.jsonFile), { recursive: true });
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2));
  }

  addEvent(title: string, at: Date, remindLead = 0): CalEvent {
    const rec: CalEvent = {
      id: 0,
      title,
      at: at.toISOString(),
      remindLead,
      notified: 0,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    if (this.backend === "sqlite") {
      const r = this.run2(
        "INSERT INTO events (title, at, remind_lead, notified, status, created_at) VALUES (?, ?, ?, 0, 'open', ?)",
        title, rec.at, remindLead, rec.createdAt,
      );
      rec.id = Number((r as { lastInsertRowid: number | bigint }).lastInsertRowid);
    } else {
      rec.id = ++this.data.seq;
      this.data.events.push(rec);
      this.persistJson();
    }
    return rec;
  }

  private run2(sql: string, ...args: unknown[]): unknown {
    return (this.db as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(sql).run(...args);
  }

  /** 未完成事件（按时间升序）；从 now 起可选只看未来 */
  listEvents(opts: { from?: Date; includePast?: boolean } = {}): CalEvent[] {
    if (this.backend === "json") {
      return this.data.events
        .filter((e) => e.status === "open" || opts.includePast)
        .filter((e) => !opts.from || new Date(e.at) >= opts.from)
        .sort((a, b) => a.at.localeCompare(b.at));
    }
    const rows = this.all<{ id: number; title: string; at: string; remind_lead: number; notified: number; status: string; created_at: string }>(
      "SELECT * FROM events ORDER BY at",
    );
    return rows
      .map((r) => ({ id: r.id, title: r.title, at: r.at, remindLead: r.remind_lead, notified: r.notified, status: r.status as CalEvent["status"], createdAt: r.created_at }))
      .filter((e) => e.status === "open" || opts.includePast)
      .filter((e) => !opts.from || new Date(e.at) >= opts.from);
  }

  markNotified(id: number): void {
    if (this.backend === "json") {
      const e = this.data.events.find((x) => x.id === id);
      if (e) e.notified = 1;
      this.persistJson();
      return;
    }
    this.run("UPDATE events SET notified = 1 WHERE id = ?", id);
  }

  finishEvent(id: number, status: "done" | "canceled" = "done"): void {
    if (this.backend === "json") {
      const e = this.data.events.find((x) => x.id === id);
      if (e) e.status = status;
      this.persistJson();
      return;
    }
    this.run("UPDATE events SET status = ? WHERE id = ?", status, id);
  }

  addTodo(text: string, due?: Date): TodoItem {
    const rec: TodoItem = { id: 0, text, due: due?.toISOString(), done: 0, createdAt: new Date().toISOString() };
    if (this.backend === "json") {
      rec.id = ++this.data.seq;
      this.data.todos.push(rec);
      this.persistJson();
      return rec;
    }
    const r = this.run2("INSERT INTO todos (text, due, done, created_at) VALUES (?, ?, 0, ?)", text, rec.due ?? null, rec.createdAt);
    rec.id = Number((r as { lastInsertRowid: number | bigint }).lastInsertRowid);
    return rec;
  }

  listTodos(): TodoItem[] {
    if (this.backend === "json") return this.data.todos.filter((t) => !t.done);
    return this.all<{ id: number; text: string; due: string | null; done: number; created_at: string }>("SELECT * FROM todos WHERE done = 0 ORDER BY id").map(
      (r) => ({ id: r.id, text: r.text, due: r.due ?? undefined, done: r.done, createdAt: r.created_at }),
    );
  }

  finishTodo(id: number): void {
    if (this.backend === "json") {
      const t = this.data.todos.find((x) => x.id === id);
      if (t) t.done = 1;
      this.persistJson();
      return;
    }
    this.run("UPDATE todos SET done = 1 WHERE id = ?", id);
  }
}
