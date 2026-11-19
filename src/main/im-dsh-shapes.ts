/**
 * 渠道适配层：Lynn 能力 → DSH RPC 形状（2026-11-18 P15-5）。
 *
 * ## 为什么有这个文件
 *
 * vendored 渠道通过 `HarnessClient` 调 17 个 RPC。它对**响应形状**有严格校验
 * （见 vendor/shared/harness-client.mjs:1136-1147、254-289、306-319）。
 * 形状不对就报 `harness-response-invalid`——表现出来就是"发消息没反应"。
 *
 * 第一版 `im-handlers.ts` 的形状是我**猜**的（`{ workspaces }`、`{ ok, data }` 之类），
 * 探测时全部失败。这个文件按 vendor 的实测校验重写。
 *
 * ## 形状清单（每条都注明依据）
 *
 * | 方法 | 形状 | 依据 |
 * |---|---|---|
 * | `host.describe` | 任意对象（health 只看 `ok`） | health() 实现 |
 * | `llm.models` | `{ groups: [{id,name,models:[{id,name}]}], failures: [] }` | :254 validateModelCatalog |
 * | `workspace.list` | `{ items: [{path,title,sessionIds}], archivedSessionIds: [] }` | :306 workspaceFromList |
 * | `session.list` | `{ items: [{sessionId, projections:{values:{title},asOfSeq}}] }` | :352 workspaceSessions |
 * | `session.create` | `{ sessionId }` | :1422 |
 * | `workspace.create` | `{ workspace: { workspaceId } }` | :1395 |
 * | `session.prompt` | 任意（调用方不校验） | :prompt 实现 |
 *
 * ## 与 im-handlers.ts 的关系
 *
 * `im-handlers.ts` 是早期手写版，形状是猜的。这个文件取代它的**形状部分**，
 * 但保留同一套 `ImHostDeps` 窄接口——内核不用改。
 */

import type { RpcHandler } from "./im-bridge";

/**
 * 内核与 IM 渠道之间的窄接口（从已删除的 im-handlers.ts 迁入）。
 *
 * 只暴露 IM 用得到的 15 个能力，**不暴露 Kernel 本体**。
 * 这是封装也是权限收窄：IM 进来的消息不能调 internal 轮。
 */
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
  /**
   * 发一轮消息。
   *
   * `source` 是渠道名（飞书 / QQ / …），会标在消息气泡上——
   * 否则手机来的消息和本地敲的看起来一模一样，分不清。
   */
  submitTurn(text: string, threadId?: string, source?: string): void;
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
import { beginTurn, endTurn, historyEvents } from "./im-ledger";

/**
 * 一个工作区在 DSH 眼里的样子。
 *
 * `workspaceId` 是必需的：`harness-client.mjs` 的 `workspaceId()` 会先读
 * `item.workspaceId`，读不到才去调 `workspace.create`。
 * 少了它每次都要走一遍创建，而且若 `path` 为空会直接报错。
 */
interface DshWorkspaceItem {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
}

/**
 * 构建渠道用的 handlers（DSH 兼容形状）。
 *
 * 与 `buildImHandlers` 的区别：只做形状，不做权限判断。
 * 权限（白名单、群聊开关）在渠道侧——那里才知道消息是谁发的。
 */
/**
 * 渠道 id → 给人看的名字（P20-1）。
 *
 * 只有白名单里的 id 会进来（桥侧已校验），所以这里可以直接映射。
 */

function channelLabel(id?: string): string | undefined {
  switch (id) {
    case "feishu":
      return "飞书";
    case "dingtalk":
      return "钉钉";
    case "qq":
      return "QQ";
    case "wecom":
    case "wecom-app":
      return "企业微信";
    case "weixin":
      return "微信";
    default:
      return undefined;
  }
}

export function buildChannelHandlers(deps: ImHostDeps): Record<string, RpcHandler> {
  /**
   * 把 Lynn 的"线程"当 DSH 的"会话"。
   *
   * 概念对应：Lynn thread = 一个对话；DSH session = 一个会话。语义等价。
   */
  const threads = () => deps.listThreads();

  /** 一个工作区（Lynn 只有"当前项目"这一个，没有多工作区概念） */
  const workspaces = (): DshWorkspaceItem[] => {
    const list = deps.listWorkspaces();
    if (!list.length) return [];
    return list.map((w) => ({
      // 工作区 id 直接用 path：Lynn 里工作区就是目录，没有独立 id
      workspaceId: w.path,
      path: w.path,
      title: w.name ?? w.path,
      // 该工作区下的会话：Lynn 的线程不归属工作区，全算进来
      sessionIds: threads().map((t) => t.id),
    }));
  };

  return {
    // ---------- 握手 ----------
    "host.describe": () => ({
      name: "lynn",
      version: deps.version(),
      methods: [
        "host.describe",
        "llm.models",
        "workspace.list",
        "workspace.create",
        "session.list",
        "session.create",
        "session.prompt",
        "session.cancel",
        "session.history",
        "session.rename",
        "session.models",
        "session.selectModel",
      ],
      unsupported: {
        "session.fork": "Lynn 没有会话分叉概念",
        "session.prepare": "无需预热",
        "session.adopt": "暂不支持接管外部会话",
        "session.permissions": "权限模型与 DSH 不同",
        "workspace.archiveSession": "暂未实现",
      },
      streaming: true,
    }),

    // ---------- 模型 ----------
    /**
     * `llm.models` 与 `session.models` 同一形状（:254）。
     * 必须按 `groups` 分组——vendored 渠道用它渲染模型选择列表。
     */
    "llm.models": () => {
      /**
       * vendor 的 `validateModelCatalog`（harness-client.mjs:254-276）要求
       * 每个模型有 `id` 与 `name` 两个非空字符串。
       * 我们的 `listModels` 返回的是 `{ id, label }`——**必须映射 label→name**，
       * 直接透传会报 `invalid response for llm.models`。
       */
      const models = deps.listModels().map((m) => ({ id: m.id, name: m.label || m.id }));
      return {
        groups: models.length ? [{ id: "default", name: "Lynn", models }] : [],
        failures: [],
      };
    },

    "session.models": () => {
      const models = deps.listModels().map((m) => ({ id: m.id, name: m.label || m.id }));
      const current = deps.currentModelId();
      return {
        groups: models.length ? [{ id: "default", name: "Lynn", models }] : [],
        failures: [],
        current: { model: current || (models[0]?.id ?? "") },
        routable: false,
      };
    },

    "session.selectModel": (payload) => {
      const p = (payload ?? {}) as { modelId?: string; model?: string };
      const id = String(p.modelId ?? p.model ?? "");
      if (!id) throw new Error("需要 modelId");
      deps.selectModel(id);
      return {};
    },

    // ---------- 工作区 ----------
    "workspace.list": () => ({
      items: workspaces(),
      // 归档会话列表：Lynn 没有归档概念，给空数组（形状校验要求它是数组）
      archivedSessionIds: [],
    }),

    /**
     * `workspace.create`。
     *
     * `path` 缺失时**不再抛错**——退回第一个已知工作区。
     *
     * 原因（真实事故）：vendor 的 `workspaceId()` 在 `workspace.list` 里
     * 找不到匹配时，会用我们传给 `HarnessClient` 的 `workspace` 去创建。
     * 那个参数一旦是 undefined，这里就会以空 path 进来；抛普通 Error 会
     * 被 vendor 映射成 `INTERNAL_UNKNOWN`，用户只看到一句"任务未完成"。
     *
     * 有兜底比抛错好：至少能跑起来，而且日志里能看到用了哪个目录。
     */
    "workspace.create": (payload) => {
      const p = (payload ?? {}) as { path?: string; cwd?: string };
      const requested = String(p.path ?? p.cwd ?? "").trim();
      const fallback = workspaces()[0]?.path ?? "";
      const path = requested || fallback;
      if (!path) {
        const e = new Error("没有可用工作区：先在应用里选一个项目目录");
        e.name = "WorkspaceUnavailable";
        throw e;
      }
      deps.createWorkspace(path);
      // :1395 —— 调用方读 `created.workspace.workspaceId`
      return { workspace: { workspaceId: path, path } };
    },

    // ---------- 会话 ----------
    /**
     * `session.list` 的形状（:352）：`{ items: [{ sessionId, projections }] }`。
     *
     * `projections.values.title` 是标题来源——渠道用它显示会话名。
     */
    "session.list": () => ({
      items: threads().map((t) => ({
        sessionId: t.id,
        blank: false,
        origin: null,
        projections: {
          values: { title: t.title },
          asOfSeq: 0,
        },
      })),
    }),

    "session.create": (payload) => {
      const p = (payload ?? {}) as { cwd?: string; workspaceId?: string; title?: string };
      // :1422 —— 调用方只读 `sessionId`
      const id = deps.createThread(p.title);
      return { sessionId: id };
    },

    /**
     * `session.prompt`：启动一轮并等它结束。
     *
     * 顺序不能反（见 turn-wait.ts）：`submitTurn` 同步返回，
     * 之后才可能有 busy 事件。
     */
    "session.prompt": async (payload, meta) => {
      const p = (payload ?? {}) as { sessionId?: string; content?: { type: string; text?: string }[] };
      const text = (p.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("")
        .trim();
      if (!text) throw new Error("content 里没有文本");
      const sessionId = p.sessionId ?? deps.currentThreadId();
      /**
       * 开轮并记账。
       *
       * `promptRpcId` 就是信封的 rpcId——vendor 用
       * `#sessionRpc('session.prompt', …, { rpcId: promptRpcId })` 提交，
       * 再用 `user/message` 的 `source.rpcId` 认领。两处必须是同一个值。
       */
      const promptRpcId = String(meta?.rpcId ?? "");
      const turnId = beginTurn(sessionId, promptRpcId, text);
      try {
        deps.submitTurn(text, sessionId, channelLabel(meta?.channel));
        await deps.waitTurn();
      } finally {
        // 无论成功失败都要收轮，否则渠道会一直停在"正在生成"
        endTurn(sessionId, "completed");
      }
      /**
       * 回答正文从账本读——`waitTurn` 期间内核的 delta 事件
       * 由 `recordEvent` 累积（见 im-bridge 的事件接线）。
       *
       * `historyEvents` 会把 `rec.answer` 包成
       * `assistant/message`（带 `data.message.content`），
       * vendor 的 `accumulateFinalAssistantText` 从中读到定稿。
       *
       * 之前账本既发 `assistant/chunk` 又发 `assistant/message`（data.text），
       * 同一文本推两次 update → 飞书卡片里正文出现两遍（"回复重复"）。
       */
      void turnId;
      return true;
    },

    "session.cancel": () => {
      deps.abortTurn();
      return {};
    },

    /**
     * `session.history`：**事件格式**，不是消息列表。
     *
     * vendor 每 300ms 轮询它来读 `history.events`（harness-client.mjs:2285-2292）。
     * 返回 `{ messages }` 会让它永远等不到 turn——第一版就是这么错的。
     *
     * `afterSeq` 是 vendor 的 `tracker.lastSeq`；我们全量返回，它自己会过滤。
     */
    "session.history": (payload, meta) => {
      const p = (payload ?? {}) as { sessionId?: string; afterSeq?: number };
      const id = p.sessionId ?? deps.currentThreadId();
      void meta;
      return { events: historyEvents(id, typeof p.afterSeq === "number" ? p.afterSeq : -1) };
    },

    "session.rename": (payload) => {
      const p = (payload ?? {}) as { sessionId?: string; title?: string };
      if (!p.sessionId || !p.title) throw new Error("需要 sessionId 与 title");
      deps.renameThread(p.sessionId, p.title);
      return {};
    },

    // ---------- 明确不支持 ----------
    "session.fork": () => {
      const e = new Error("这个方法暂不支持：session.fork（Lynn 没有会话分叉概念）");
      e.name = "UnsupportedMethod";
      throw e;
    },
    "session.prepare": () => ({}),
    "session.adopt": () => {
      const e = new Error("这个方法暂不支持：session.adopt（暂不支持接管外部会话）");
      e.name = "UnsupportedMethod";
      throw e;
    },
    "session.permissions": () => ({
      // 形状未知（vendor 里未见校验）——给一个最小可用结构，渠道会自行降级
      permissions: [],
    }),
    "workspace.archiveSession": () => {
      const e = new Error("这个方法暂不支持：workspace.archiveSession（暂未实现）");
      e.name = "UnsupportedMethod";
      throw e;
    },
  };
}