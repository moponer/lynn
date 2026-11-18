/**
 * 飞书渠道（vendored 版，2026-11-18 P16-1）。
 *
 * 用 vendor 里 dsh-im 的原实现（`feishu/feishu-runtime.mjs`，26 个文件 / 608 KB），
 * 我们只做**接线**，不改它的逻辑。
 *
 * ## 为什么换成 vendored 版
 *
 * 我早先手写的 `im-feishu.ts` 只有"收文本 → 跑一轮 → 回文本"，约 260 行。
 * vendored 版有卡片、流式、斜杠命令、群历史、二维码修复、语音、审批……
 * **能力差一个量级**。手写版应该被取代，不是并存。
 *
 * ## 它需要什么（实测）
 *
 * | 参数 | 我们给什么 |
 * |---|---|
 * | `lark` | `@larksuiteoapi/node-sdk` **模块本身**（它用 `lark.Client` / `lark.Domain`） |
 * | `appId` / `appSecret` | 设置里的飞书配置（secret 由内核解密后传进来） |
 * | `ownerOpenIds` | **白名单**——它会把这里变成 `allowedSenderOpenIds` |
 * | `harness` | 我们的 `HarnessClient`（vendor 的，指向本地桥） |
 * | `state` | `feishu/state-store.mjs` 的 `StateStore`（落盘在 dataRoot/im/） |
 * | `groupResponseMode` | `'mention'`（只在被 @ 时响应，比 `'all'` 安全） |
 *
 * ## 安全
 *
 * 白名单是**第一道也是最后一道闸**：`ownerOpenIds` 变成
 * `allowedSenderOpenIds`，群聊消息也受它约束（不是只看私聊）。
 * 所以"群聊默认不响应"这条在 vendored 版里变成了
 * "群聊只响应白名单里的人，且只在他们 @ 机器人时"——比手写版宽松一点，
 * 但仍不允许陌生人驱动 Agent。
 *
 * 如果你要的是**绝对不进群**，把 `groupResponseMode` 留给将来的开关；
 * 当前实现选择"受白名单约束的 mention"，因为它更符合真实用法。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isValidOpenId } from "./im-openid";
import { observeFeishuSdk } from "./im-feishu-observe";
import { createVendorHarness, loadStateStore } from "./im-harness";

/** 飞书渠道配置 */
export interface FeishuVendorConfig {
  appId: string;
  appSecret: string;
  /** 允许驱动 Agent 的用户 open_id（**空 = 拒绝启动**） */
  allowOpenIds: string[];
  /** 是否响应群聊（false → 仍用 mention 模式，但白名单照旧生效） */
  allowGroup?: boolean;
}

export interface FeishuVendorDeps {
  config: FeishuVendorConfig;
  /** 本地 IM 桥的地址（我们的 im-bridge） */
  bridgeBaseUrl: string;
  /** 桥的 token（我们注入进 fetch 与 WS query） */
  bridgeToken: string;
  /** 数据目录（StateStore 落盘用） */
  dataRoot: string;
  log(event: string, detail?: Record<string, unknown>): void;
  onState?(state: string, detail?: string): void;
  /**
   * 每条进来的消息都会回调（P18-2）。
   *
   * 壳层用它把"见过的发送者"记进设置，设置页就能直接列出候选 id —— 
   * 不依赖 `im:chat:readonly`，也不依赖用户先去翻日志。
   */
  onSender?(seen: { openId: string; chatType: string; chatId: string }): void;
}

/** vendored 飞书 runtime 的最小类型（不引 .d.ts：那是 JS） */
interface FeishuRuntimeLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 是 **getter** 不是方法（`get status()`）——写成方法会报 "is not a function" */
  readonly status: unknown;
}

/** 渠道句柄 */
export interface FeishuVendorHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): unknown;
}



/**
 * 创建 vendored 飞书渠道。
 *
 * 抛错的情形都是**配置问题**，错误信息要能直接指导用户改什么。
 */
export async function createFeishuVendorChannel(deps: FeishuVendorDeps): Promise<FeishuVendorHandle> {
  const { config, bridgeBaseUrl, bridgeToken, dataRoot } = deps;

  // ---------- 前置校验（早失败，说得清） ----------
  if (!config.appId || !config.appSecret) {
    throw new Error("飞书渠道缺少 appId / appSecret");
  }
  const owners = config.allowOpenIds.map((s) => s.trim()).filter(Boolean);
  if (!owners.length) {
    /**
     * 白名单为空**拒绝启动**，不是"启动了但谁都不理"。
     * 后者更难排查：用户会以为连上了，实际每条消息都被静默丢弃。
     */
    throw new Error("飞书渠道的白名单为空：先在设置里加上允许的用户 open_id，否则任何人都能驱动 Agent");
  }
  const bad = owners.filter((id) => !isValidOpenId(id));
  if (bad.length) {
    throw new Error(
      `open_id 格式不对：${bad.join("、")}。正确格式是 ou_ 加 32 位十六进制（共 35 字符），检查是否多复制了字符。`,
    );
  }

  // ---------- 加载 vendored 实现与平台 SDK ----------
  let lark: unknown;
  try {
    lark = await import("@larksuiteoapi/node-sdk");
  } catch (err) {
    throw new Error(
      `飞书 SDK 没装：${err instanceof Error ? err.message : String(err)}。装它：npm install @larksuiteoapi/node-sdk`,
    );
  }
  // 有些包是 { default: {...} } 形态
  const rawSdk = ((lark as { default?: unknown }).default ?? lark) as Record<string, unknown>;
  /**
   * 包一层：观察每条进来的消息的发送者（P18-2）。
   *
   * 为什么必须这样做：**open_id 按应用隔离**，用户必须拿到这个 app 下的 id；
   * 而 `GET /im/v1/chats` 只返回群、不返回私聊，API 查不到"只私聊过"的情形。
   * vendored 渠道拒收时又只打一句没有 id 的警告。
   *
   * 观察器包裹 SDK 的 `EventDispatcher.register`——vendor 一行不改，
   * 被白名单拒掉的消息也会先被我们记下来。
   */
  const sdk = observeFeishuSdk(rawSdk, (seen) => {
    deps.log("feishu_sender_seen", {
      openId: seen.openId,
      chatType: seen.chatType,
      chatId: seen.chatId,
      // 是否在白名单里——用户一眼能看出"就是差这一个字符"
      inAllowList: config.allowOpenIds.includes(seen.openId),
    });
    deps.onSender?.(seen);
  });

  /**
   * 加载 vendor 的 `.mjs`。
   *
   * 为什么要绕一层：本项目的 main 编译目标是 **CommonJS**，tsc 会把
   * `import()` 降级成 `require()`——而 `.mjs` 不能被 require 加载
   * （报 `Cannot find module './vendor/...mjs'`）。
   * 用 `Function` 包一层可以保留**原生** `import()`。
   *
   * 用绝对路径而不是相对路径：dist 与 src 的目录深度不同，
   * 相对路径在编译后会指向不存在的位置。
   */
  const importEsm = (spec: string): Promise<Record<string, unknown>> =>
    (Function("s", "return import(s)") as (s: string) => Promise<Record<string, unknown>>)(spec);

  const vendorDir = path.join(__dirname, "im", "vendor");
  const { FeishuRuntime } = (await importEsm(pathToFileURL(path.join(vendorDir, "feishu", "feishu-runtime.mjs")).href)) as {
    FeishuRuntime: new (opts: Record<string, unknown>) => FeishuRuntimeLike;
  };
  const { StateStore } = (await importEsm(pathToFileURL(path.join(vendorDir, "feishu", "state-store.mjs")).href)) as {
    StateStore: new (p: string) => unknown;
  };
  // ---------- 状态落盘目录 ----------
  const stateDir = path.join(dataRoot, "im", "feishu");
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateStore(path.join(stateDir, "state.json"));
  /** 必须显式 load：vendor 不会自己调（见 im-harness.ts 的说明） */
  await loadStateStore(state);

  /**
   * Harness：指向我们的本地桥（复用 im-harness 的共享构造）。
   *
   * 第三个参数是**渠道标识**——它会作为 `x-lynn-channel` 头随每个 RPC 发出，
   * 桥据此把消息卡标成「你（飞书）」。六个渠道共用一个桥，只能走传输层传。
   */
  const harness = await createVendorHarness(bridgeBaseUrl, bridgeToken, "feishu");

  // ---------- 组装 runtime ----------
  const runtime = new FeishuRuntime({
    lark: sdk,
    appId: config.appId,
    appSecret: config.appSecret,
    /**
     * 白名单：它会把这里变成 `allowedSenderOpenIds`。
     * **群聊消息也受它约束**——这是我们的安全边界。
     */
    ownerOpenIds: owners,
    /**
     * 群聊只在被 @ 时响应。`all` 会让它响应群里每一句，
     * 即使有白名单也太吵；`mention` 是安全的那一档。
     */
    groupResponseMode: config.allowGroup ? "all" : "mention",
    harness,
    state,
    logger: {
      info: (...a: unknown[]) => deps.log("feishu_info", { msg: a.map(String).join(" ").slice(0, 200) }),
      warn: (...a: unknown[]) => deps.log("feishu_warn", { msg: a.map(String).join(" ").slice(0, 200) }),
      error: (...a: unknown[]) => deps.log("feishu_error", { msg: a.map(String).join(" ").slice(0, 200) }),
      debug: () => {},
    } as unknown as Console,
  }) as unknown as FeishuRuntimeLike;

  deps.log("feishu_vendor_ready", { appId: config.appId, owners: owners.length, allowGroup: config.allowGroup === true });

  return {
    async start() {
      deps.onState?.("connecting");
      try {
        await runtime.start();
        deps.onState?.("connected");
        deps.log("feishu_connected", { appId: config.appId, owners: owners.length });
      } catch (err) {
        deps.onState?.("error", err instanceof Error ? err.message : String(err));
        deps.log("feishu_start_failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    async stop() {
      try {
        await runtime.stop();
      } finally {
        deps.onState?.("idle");
      }
    },
    status() {
      // `status` 是 getter：取属性，不是调用
      return runtime.status;
    },
  };
}