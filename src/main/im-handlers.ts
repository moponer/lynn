/**
 * IM 网关的 RPC handlers（2026-11-18 P13-3）。
 *
 * 把 `dsh-im` 的 17 个方法映射到 Lynn 的能力上。
 *
 * ## 分工
 *
 * `im-bridge.ts` 只管 HTTP 与安全（token / Origin / 大小 / 白名单）；
 * 这个文件只管**语义映射**——每个方法对应 Lynn 的哪个能力。
 *
 * 分开的好处：安全边界与业务逻辑各自可测，改一个不影响另一个。
 *
 * ## 映射原则
 *
 * 1. **有对应能力就接**（12 个）；
 * 2. **没有明确对应就返回"不支持"**，不猜。猜出来的行为比没有更糟——
 *    调用方会以为成功，然后基于错误的状态继续跑。
 * 3. **流的处理**：`session.prompt` 在 Lynn 是流式（`submitTurn` 返回 void），
 *    这里要等这一轮结束再返回。用事件监听 + 超时。
 */
import type { RpcHandler } from "./im-bridge";

/** 这个文件需要的内核能力（窄接口，不接收整个 Kernel） */
export interface ImHostDeps {
  /** 列会话 */
  listThreads(): { id: string; title: string; updatedAt?: string }[];
  /** 建会话，返回 id */
  createThread(title?: string): string;
  /** 切到某个会话 */
  switchThread(id: string): void;
  /** 改名 */
  renameThread(id: string, title: string): void;
  /** 读会话历史（消息列表） */
  threadHistory(id: string): unknown[];
  /** 当前会话 id */
  currentThreadId(): string;
  /**
   * 发一轮消息。
   *
   * **语义是"启动"**，不是"等完成"：Lynn 的 submitTurn 是 void + 流式，
   * 它之后回答通过 `delta` 事件推给界面。
   * 要等它结束，用 `waitTurn()`（见 turn-wait.ts）。
   */
  submitTurn(text: string, threadId?: string): void;
  /**
   * 等这一轮结束。
   *
   * 与 `submitTurn` 分开的原因：`submitTurn` 同步返回，之后才可能有 busy 事件；
   * 合在一起会出现在"busy 还没置起来"时就误判完成的竞态。
   */
  waitTurn(): Promise<void>;
  /** 中断当前轮 */
  abortTurn(): void;
  /** 可用模型列表 */
  listModels(): { id: string; label?: string }[];
  /** 当前模型 id */
  currentModelId(): string;
  /** 切模型 */
  selectModel(modelId: string, threadId?: string): void;
  /** 列工作区 */
  listWorkspaces(): { path: string; name?: string }[];
  /** 建工作区 */
  createWorkspace(path: string): void;
  /** 版本号（握手用） */
  version(): string;
}


/** 明确的"不支持"：调用方要能区分"没实现"与"出错了" */
function unsupported(method: string, why: string): never {
  const err = new Error(`这个方法暂不支持：${method}（${why}）`);
  err.name = "UnsupportedMethod";
  throw err;
}

/**
 * 构建 handlers。
 *
 * 17 个方法的实现情况：
 *  - 12 个有对应能力 → 接上
 *  - 3 个需薄封装（models / permissions / adopt）→ 尽量接，接不了的明确拒
 *  - 2 个明确不支持（fork / prepare）
 */
export function buildImHandlers(deps: ImHostDeps): Record<string, RpcHandler> {
  return {
    // ---------- 握手 ----------
    /**
     * `host.describe`：调用方靠它判断宿主有什么能力。
     *
     * 必须如实报——它据此决定调哪些方法。谎报会导致调用方去调不存在的方法。
     */
    "host.describe": () => ({
      name: "lynn",
      version: deps.version(),
      /** 支持的方法清单（调用方据此裁剪功能） */
      methods: [
        "host.describe",
        "llm.models",
        "session.create",
        "session.list",
        "session.prompt",
        "session.cancel",
        "session.history",
        "session.rename",
        "session.models",
        "session.selectModel",
        "workspace.list",
        "workspace.create",
      ],
      /** 明确不支持的能力，调用方要据此降级 */
      unsupported: {
        "session.fork": "Lynn 没有会话分叉概念",
        "session.prepare": "无需预热",
        "session.adopt": "暂未实现接管外部会话",
        "session.permissions": "权限模型与 DSH 不同，未做映射",
        "workspace.archiveSession": "暂未实现",
      },
      /** 流式能力：本轮未实现 WebSocket，prompt 是"等结束再返回" */
      streaming: false,
    }),

    // ---------- 模型 ----------
    "llm.models": () => ({
      models: deps.listModels().map((m) => ({ id: m.id, label: m.label ?? m.id })),
      current: deps.currentModelId(),
    }),

    // ---------- 会话 ----------
    "session.list": () => ({
      sessions: deps.listThreads().map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt ?? null,
        current: t.id === deps.currentThreadId(),
      })),
    }),

    "session.create": (payload) => {
      const p = (payload ?? {}) as { title?: string };
      const id = deps.createThread(p.title);
      return { id, title: p.title ?? "" };
    },

    "session.prompt": async (payload) => {
      const p = (payload ?? {}) as { text?: string; sessionId?: string };
      const text = String(p.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      /**
       * 启动 + 等待要**分开两步**：
       *
       * 1. 先 `submitTurn` 把这一轮启动起来；
       * 2. 再 `waitTurn` 等它结束。
       *
       * 不能反过来，也不能合并——`submitTurn` 同步返回，它之后的下一个事件
       * 才可能是 `busy=true`。先等就会在 busy 还没置起来时误判"已完成"。
       *
       * 超时由 `waitTurn` 内部处理（它知道这一轮的真实时序）。
       */
      deps.submitTurn(text, p.sessionId);
      await deps.waitTurn();
      return { ok: true };
    },

    "session.cancel": () => {
      deps.abortTurn();
      return { ok: true };
    },

    "session.history": (payload) => {
      const p = (payload ?? {}) as { sessionId?: string };
      const id = p.sessionId ?? deps.currentThreadId();
      return { messages: deps.threadHistory(id) };
    },

    "session.rename": (payload) => {
      const p = (payload ?? {}) as { sessionId?: string; title?: string };
      if (!p.sessionId || !p.title) throw new Error("需要 sessionId 与 title");
      deps.renameThread(p.sessionId, p.title);
      return { ok: true };
    },

    "session.models": () => ({
      models: deps.listModels().map((m) => ({ id: m.id, label: m.label ?? m.id })),
      current: deps.currentModelId(),
    }),

    "session.selectModel": (payload) => {
      const p = (payload ?? {}) as { modelId?: string; sessionId?: string };
      if (!p.modelId) throw new Error("需要 modelId");
      deps.selectModel(p.modelId, p.sessionId);
      return { ok: true };
    },

    // ---------- 工作区 ----------
    "workspace.list": () => ({
      workspaces: deps.listWorkspaces().map((w) => ({ path: w.path, name: w.name ?? w.path })),
    }),

    "workspace.create": (payload) => {
      const p = (payload ?? {}) as { path?: string };
      if (!p.path) throw new Error("需要 path");
      deps.createWorkspace(p.path);
      return { ok: true };
    },

    // ---------- 明确不支持 ----------
    "session.fork": () => unsupported("session.fork", "Lynn 没有会话分叉概念"),
    "session.prepare": () => unsupported("session.prepare", "无需预热"),
    "session.adopt": () => unsupported("session.adopt", "暂未实现接管外部会话"),
    "session.permissions": () => unsupported("session.permissions", "权限模型与 DSH 不同，未做映射"),
    "workspace.archiveSession": () => unsupported("workspace.archiveSession", "暂未实现"),
  };
}