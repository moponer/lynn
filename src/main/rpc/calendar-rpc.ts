// 日历域 RPC（2026-11-16 第三批）：从 kernel.handle 的 switch 里搬出来的 calendar.* 七件。
//
// 依赖只声明"用到的能力"，不接收 Kernel：域内只有日历与"扫一遍到期提醒"这个回调。
// scanReminders 之所以是回调而不是 store 方法：它要落卡、发系统通知，属内核编排，
// 日历自己不该知道界面与通知的存在。
import { parseNaturalDate, type CalendarStore } from "../calendar";

export type CalendarStorePort = Pick<
  CalendarStore,
  "backend" | "addEvent" | "listEvents" | "finishEvent" | "addTodo" | "listTodos" | "finishTodo"
>;

export interface CalendarRpcDeps {
  calendar: CalendarStorePort;
  scanReminders(): void;
}

/** 与其它域一致：入参/返回值仍是 unknown，契约收口在 Kernel.calendarRpcDeps() 一处 */
export interface CalendarRpc {
  add(params: unknown): unknown;
  list(params: unknown): unknown;
  finish(params: unknown): unknown;
  todoAdd(params: unknown): unknown;
  todoList(): unknown;
  todoFinish(params: unknown): unknown;
  scan(): unknown;
}

export function createCalendarRpc(deps: CalendarRpcDeps): CalendarRpc {
  const { calendar } = deps;
  return {
    add(params: unknown): unknown {
      const { text, remindLead } = params as { text: string; remindLead?: number };
      const parsed = parseNaturalDate(text);
      if (!parsed) {
        return {
          ok: false,
          error: `没识别出时间。支持的写法如：明天下午三点、下周三 14:00、3月5号上午九点、两小时后。`,
        };
      }
      const title = parsed.rest || String(text ?? "").trim();
      const ev = calendar.addEvent(title, parsed.at, Math.max(0, Number(remindLead ?? 0)));
      return {
        ok: true,
        event: { id: ev.id, title: ev.title, at: ev.at },
        matched: parsed.matched,
        defaultedTime: parsed.defaultedTime,
      };
    },

    list(params: unknown): unknown {
      const { includePast } = (params ?? {}) as { includePast?: boolean };
      const events = calendar.listEvents({ includePast }).map((e) => ({
        id: e.id,
        title: e.title,
        at: e.at,
        status: e.status,
      }));
      return { events, backend: calendar.backend };
    },

    finish(params: unknown): unknown {
      const { id, status } = params as { id: number; status?: "done" | "canceled" };
      calendar.finishEvent(Number(id), status === "canceled" ? "canceled" : "done");
      return { ok: true };
    },

    todoAdd(params: unknown): unknown {
      const { text } = params as { text: string };
      const t = calendar.addTodo(String(text).trim());
      return { ok: true, id: t.id };
    },

    todoList(): unknown {
      const todos = calendar.listTodos().map((t) => ({ id: t.id, text: t.text, due: t.due }));
      return { todos };
    },

    todoFinish(params: unknown): unknown {
      const { id } = params as { id: number };
      calendar.finishTodo(Number(id));
      return { ok: true };
    },

    scan(): unknown {
      deps.scanReminders();
      return { ok: true };
    },
  };
}
