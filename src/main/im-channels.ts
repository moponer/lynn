/**
 * 国内渠道适配层（2026-11-18 P19-2）。
 *
 * 除飞书外的四个渠道——**钉钉 / QQ / 企业微信 / 微信**——共用这一个工厂。
 * 它们的构造契约几乎一样（实测）：
 *
 * ```
 * new XxxRuntime({ config, <secret>, harness, state, … })
 * ```
 *
 * 差别只在 `config` 的字段名与 secret 的叫法，所以用一张**描述表**而不是
 * 五份复制粘贴的代码。代码一样的地方复制五遍，改的时候必然漂移。
 *
 * | 渠道 | config 字段 | secret | 状态存储 |
 * |---|---|---|---|
 * | 钉钉 | `clientId, botId` | `clientSecret` | `DingtalkStateStore` |
 * | QQ | `appId, botId` | `appSecret` | `QqStateStore` |
 * | 企业微信 | `remoteBotId, botId` | `secret` | `WecomStateStore` |
 * | 微信 | `baseUrl, botId` | （token） | `WeixinStateStore` |
 *
 * ## 企业微信「应用」（wecom-app）不在本文件
 *
 * 它**必须有公网可达的回调地址**（vendor 里没有出站 WebSocket，
 * 接收只能靠 HTTP 回调）。桌面应用默认没有公网入口，所以它需要用户
 * 自建隧道。单独放在后面处理，不混进来让人误以为"开箱可用"。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createVendorHarness, loadVendor, vendorLogger } from "./im-harness";

/** 本文件支持的渠道 */
export type SimpleChannelId = "dingtalk" | "qq" | "wecom" | "weixin";

/** 渠道配置：字段随渠道不同，由描述表解释 */
export interface SimpleChannelConfig {
  /** 渠道 id */
  channel: SimpleChannelId;
  /** 主标识（钉钉 clientId / QQ appId / 企业微信 remoteBotId / 微信 accountId） */
  primary: string;
  /** 从标识派生的 botId（vendor 用它做内部键） */
  botId: string;
  /** secret（已解密）；微信是 token */
  secret: string;
  /** 微信专用：iLink 服务地址 */
  baseUrl?: string;
  /** 微信专用：允许驱动 Agent 的用户 id */
  ownerUserId?: string;
  /** 钉钉专用：允许的发送者 staffId */
  approvedSenders?: string[];
}

export interface SimpleChannelDeps {
  config: SimpleChannelConfig;
  bridgeBaseUrl: string;
  bridgeToken: string;
  dataRoot: string;
  log(event: string, detail?: Record<string, unknown>): void;
  onState?(state: string, detail?: string): void;
}

export interface ChannelHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): unknown;
}

/** 一个 runtime 实例的最小形状（vendor 是 JS，只声明用到的） */
interface RuntimeLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: unknown;
}

/** 每个渠道的"接线配方" */
interface ChannelRecipe {
  /** runtime 模块（vendor 相对路径） */
  runtime: string;
  /** state store 模块 + 类名 */
  stateStore: { module: string; name: string };
  /** 构造 runtime 的入参（除 config/state/harness 外） */
  build(cfg: SimpleChannelConfig): Record<string, unknown>;
  /** 标签（错误信息用） */
  label: string;
  /**
   * 额外的构造参数（个别渠道需要，比如微信要一个 API 客户端对象）。
   * 异步是因为它要从 vendor 里加载对应模块。
   */
  extra?: () => Promise<Record<string, unknown>>;
}

const RECIPES: Record<SimpleChannelId, ChannelRecipe> = {
  dingtalk: {
    label: "钉钉",
    runtime: "dingtalk/dingtalk-runtime.mjs",
    stateStore: { module: "dingtalk/state-store.mjs", name: "DingtalkStateStore" },
    build: (c) => ({
      config: {
        clientId: c.primary,
        botId: c.botId,
        ...(c.approvedSenders?.length ? { approvedSenders: c.approvedSenders } : {}),
      },
      clientSecret: c.secret,
    }),
  },
  qq: {
    label: "QQ",
    runtime: "qq/qq-runtime.mjs",
    stateStore: { module: "qq/state-store.mjs", name: "QqStateStore" },
    build: (c) => ({
      config: { appId: c.primary, botId: c.botId },
      appSecret: c.secret,
    }),
  },
  wecom: {
    label: "企业微信",
    runtime: "wecom/wecom-runtime.mjs",
    stateStore: { module: "wecom/state-store.mjs", name: "WecomStateStore" },
    build: (c) => ({
      config: { remoteBotId: c.primary, botId: c.botId },
      secret: c.secret,
    }),
  },
  weixin: {
    label: "微信",
    runtime: "weixin/weixin-runtime.mjs",
    stateStore: { module: "weixin/state-store.mjs", name: "WeixinStateStore" },
    build: (c) => ({
      config: {
        baseUrl: c.baseUrl ?? "https://ilinkai.weixin.qq.com",
        botId: c.botId,
        ...(c.ownerUserId ? { ownerUserId: c.ownerUserId } : {}),
      },
      token: c.secret,
    }),
    /**
     * 微信还要一个 API 客户端对象（`WeixinRuntime requires API, account, token, …`）。
     * vendor 提供了工厂 `createWeixinApi({ fetchImpl })`，这里直接用它。
     */
    extra: async () => {
      const apiMod = await loadVendor("weixin/weixin-api.mjs");
      const create = apiMod.createWeixinApi;
      if (typeof create !== "function") throw new Error("微信：vendor 里找不到 createWeixinApi");
      return { api: (create as (o?: Record<string, unknown>) => unknown)({}) };
    },
  },
};

/**
 * 创建渠道。
 *
 * 配置不全时**早失败并说清缺什么**——比"启动了但收不到消息"好排查。
 */
export async function createSimpleChannel(deps: SimpleChannelDeps): Promise<ChannelHandle> {
  const { config, bridgeBaseUrl, bridgeToken, dataRoot } = deps;
  const recipe = RECIPES[config.channel];
  if (!recipe) throw new Error(`未知渠道：${String(config.channel)}`);
  const label = recipe.label;

  if (!config.primary) throw new Error(`${label}渠道缺少主标识（appId / clientId / bot 标识）`);
  if (!config.secret) throw new Error(`${label}渠道缺少 secret`);
  if (config.channel === "weixin" && !config.ownerUserId) {
    /**
     * 微信必须指定 owner：vendor 用它做 owner 校验。
     * 不给就是"谁都能驱动 Agent"——比不能启动更糟。
     */
    throw new Error("微信渠道需要 ownerUserId（允许驱动 Agent 的用户 id）");
  }

  // ---------- 加载 vendor 模块 ----------
  const runtimeMod = await loadVendor(recipe.runtime);
  const Runtime = runtimeMod[recipe.runtime.split("/")[1]!.replace("-runtime.mjs", "Runtime")] ??
    Object.values(runtimeMod).find((v) => typeof v === "function" && /Runtime$/.test(v.name));
  if (typeof Runtime !== "function") {
    throw new Error(`${label}：vendor 里找不到 Runtime 类（${recipe.runtime}）`);
  }
  const stateMod = await loadVendor(recipe.stateStore.module);
  const StateStore = stateMod[recipe.stateStore.name];
  if (typeof StateStore !== "function") {
    throw new Error(`${label}：vendor 里找不到 ${recipe.stateStore.name}`);
  }

  // ---------- 状态落盘 ----------
  const stateDir = path.join(dataRoot, "im", config.channel);
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new (StateStore as new (p: string) => unknown)(path.join(stateDir, "state.json"));

  // ---------- Harness ----------
  const harness = await createVendorHarness(bridgeBaseUrl, bridgeToken);

  // ---------- 组装 ----------
  const extra = recipe.extra ? await recipe.extra() : {};
  const runtime = new (Runtime as new (o: Record<string, unknown>) => RuntimeLike)({
    ...recipe.build(config),
    ...extra,
    harness,
    state,
    logger: vendorLogger(deps.log, config.channel),
  });

  deps.log(`${config.channel}_vendor_ready`, { primary: config.primary, botId: config.botId });

  return {
    async start() {
      deps.onState?.("connecting");
      try {
        await runtime.start();
        deps.onState?.("connected");
        deps.log(`${config.channel}_connected`, { primary: config.primary });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.onState?.("error", msg);
        deps.log(`${config.channel}_start_failed`, { error: msg.slice(0, 240) });
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
      // vendor 的 status 是 getter（与飞书一致），不是方法
      return runtime.status;
    },
  };
}

/** 从标识派生 botId（与 vendor 的 derive*Identity 保持一致的思路：稳定、可读） */
export function deriveBotId(channel: SimpleChannelId, primary: string): string {
  switch (channel) {
    case "dingtalk":
      return `dingtalk:${primary}`;
    case "qq":
      return `qq:${primary}`;
    case "wecom":
      return `wecom:${primary}`;
    case "weixin":
      return `weixin:${primary}`;
  }
}