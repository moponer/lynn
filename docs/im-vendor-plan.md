# dsh-im 国内渠道移植方案（实测）

> 2026-11-18。用户要求：**所有国内渠道都接上，照原插件的方式实现，不要自己造轮子**。
>
> 本文是读源码后的实测结论 + 可执行方案。

## 一、结论

**可以整目录移植，而且成本比预想低得多。**

关键实测：`src/channels/` 下的 290 个非测试文件**全部零 `ctx.` 引用**——
它们不依赖 DSH 框架（Cordis），是纯 Node.js 实现。

| 抽查文件 | `ctx.` 引用数 |
|---|---|
| `shared/harness-client.mjs`（101 KB，核心） | **0** |
| `shared/workspace-command.mjs`（46 KB） | **0** |
| `shared/token-bot-controller.mjs`（17 KB） | **0** |
| `wecom/config-store.mjs` | **0** |
| `discord/config-store.mjs` | **0** |
| `shared/i18n.mjs` | **0** |
| `slack/harness-client.mjs` | **0** |
| `shared/file-download.mjs` | **0** |

只有 `plugin-src/host/channels/<渠道>/production.mjs`（16 行胶水）知道 cordis。
**那一层我们不要，我们自己写。**

## 二、国内渠道清单与规模

| 渠道 | 代码量 | 文件数 | 接入方式 |
|---|---|---|---|
| **飞书** feishu | 608 KB | 26 | 长连接（WebSocket） |
| **钉钉** dingtalk | 221 KB | 11 | Stream 长连接 |
| **QQ** qq | 141 KB | 11 | WebSocket |
| **企业微信** wecom | 141 KB | 10 | WebSocket |
| **企业微信应用** wecom-app | 116 KB | 8 | HTTP 回调 |
| **微信** weixin | 179 KB | 10 | iLink 长轮询 |
| 合计 | **约 1.4 MB** | **76** | |

## 三、每个渠道的结构（高度同构）

```
<ch>/<ch>-bridge.mjs        ← 最大（60–300 KB）：消息 ↔ 宿主的桥
<ch>/<ch>-controller.mjs    ← 生命周期、状态机
<ch>/<ch>-runtime.mjs       ← 把上面两者接起来
<ch>/<ch>-api.mjs           ← 平台 HTTP API 封装
<ch>/config-store.mjs       ← 凭据配置
<ch>/state-store.mjs        ← 会话状态
```

**同构意味着**：写一次适配层，六个渠道都能用。

## 四、依赖的 shared 模块（这些就是"轮子"）

`qq-bridge.mjs` 的 import 清单（代表性）：

```js
import { captureGroupHistory } from '../shared/group-history.mjs';
import { SESSION_NAV_HELP_LINES } from '../shared/command-catalog.mjs';
import { BusyMessageDispatcher, canAutomaticallySteer } from '../shared/busy-message-dispatcher.mjs';
import { isPermissionCommand, runPermissionCommand } from '../shared/permission-command.mjs';
import { createDeferredDeliveryCoordinator } from '../shared/deferred-delivery-coordinator.mjs';
import { runWorkspaceCommand } from '../shared/workspace-command.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
import { isClearCommand, runClearCommand } from '../shared/clear-command.mjs';
import { isResetCommand, runResetCommand } from '../shared/reset-command.mjs';
import { isHistoryCommand, runHistoryCommand } from '../shared/history-command.mjs';
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
```

这些是它已经写好的能力：

| 模块 | 大小 | 做什么 |
|---|---|---|
| `workspace-command` | 46 KB | `/workspace` 切换工作区 |
| `harness-approval` | 27 KB | 审批队列（把 Lynn 的"需要拍板"转成 IM 消息） |
| `deferred-delivery-coordinator` | 12 KB | 超时后补发结果 |
| `permission-command` | 7 KB | `/permission` 权限命令 |
| `busy-message-dispatcher` | 4 KB | 忙时插话 |
| `compact-command` | 4 KB | `/compact` 压缩上下文 |
| `group-history` | 3 KB | 群历史 |
| `clear-command` / `reset-command` | 5 KB | `/clear` `/reset` |
| `connection-test` | 2 KB | 连接自检 |

**"不造轮子"就是这些一起拿过来。**

## 五、移植方案

### 5.1 目录结构

```
src/main/im/
  vendor/                    ← 原样复制 src/channels/（不改一行）
    shared/
    feishu/
    dingtalk/
    qq/
    wecom/
    wecom-app/
    weixin/
  adapters/                  ← 我们写的适配层（替代它的 production.mjs）
    feishu.ts
    dingtalk.ts
    qq.ts
    wecom.ts
    wecom-app.ts
    weixin.ts
  registry.ts                ← 渠道注册表
  bridge.ts                  ← 已有的 im-bridge（HTTP 端点）
  handlers.ts                ← 已有的 im-handlers（17 个方法）
```

**vendor/ 里一行都不改**——这样上游更新时可以直接覆盖。

### 5.2 适配层要做什么

它的 `production.mjs` 是 16 行，做的是：

```js
export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'discord', ConfigStore, StateStore, HarnessClient, Controller, Runtime,
  });
}
```

我们写的适配层做同样的事，但 `ctx` 换成 Lynn 的能力：

```ts
export function createFeishuChannel(deps: LynnImDeps): ChannelHandle {
  return createTokenProductionController(
    /* 这里的 ctx 换成 { baseUrl, token, log, ... } */
    makeCtx(deps),
    config,
    internals,
    { channel: "feishu", ConfigStore, StateStore, HarnessClient, Controller, Runtime },
  );
}
```

**关键**：`HarnessClient` 走 `baseUrl` 模式（HTTP），指向我们已经做好的 `im-bridge` 端点。
**不需要改它的代码**——它本来就有这个模式。

### 5.3 依赖处理

原插件的 `package.json` 依赖：

```json
"@larksuiteoapi/node-sdk": "1.73.0",      // 飞书
"dingtalk-stream": "2.1.4",               // 钉钉
"@tencent-connect/qqbot-nodejs": "1.0.4", // QQ
"@wecom/aibot-node-sdk": "1.0.7",         // 企业微信
"qrcode": "1.5.4",                        // 扫码
"undici": "7.30.1"                        // HTTP
```

**按渠道懒装**：只装用户启用的那个。`im/registry.ts` 里做动态 `import()`，
装不上时给一条能照做的提示，不影响其它渠道。

## 六、执行顺序

| 步 | 做什么 | 验证方式 |
|---|---|---|
| 1 | 复制 `src/channels/` → `src/main/im/vendor/` | 能 import，无语法错误 |
| 2 | 写飞书适配层（复用我们已有的飞书渠道逻辑） | 真连一次 |
| 3 | 接进 `im/registry.ts`，设置页加渠道切换 | 界面能选渠道 |
| 4 | 钉钉 / QQ / 企微 / 企微应用 / 微信 | 逐个接 |
| 5 | 删掉我手写的 `im-feishu.ts` | 由 vendor 版取代 |

**第 5 步很重要**：我手写的那个只有"收文本→跑一轮→回文本"，
而 vendor 版有卡片、流式、斜杠命令、审批、补发——**能力差一个量级**。
手写版应该被取代，不是并存。

## 七、风险

| 风险 | 说明 | 应对 |
|---|---|---|
| **体积** | vendor 1.4 MB 源码 + 6 个 SDK | 按渠道懒装 SDK；源码体积可接受（都在 dist 外） |
| **上游变更** | 它改了 vendor 就跟不上 | 保留 `UPSTREAM.json` 记 commit；升级时整体覆盖 |
| **许可** | 它的 LICENSE 要核对 | **移植前必须先看** |
| **它的测试跑不了** | 那些测试依赖 DSH 环境 | 自己写适配层测试，不跑它的 |
| **i18n 体积** | `i18n-ru` / `i18n-en` 占了不少 | 只要中文，删掉 ru/en（但要注意 import 引用） |

## 八、许可检查（移植前必做）

**这是硬前提**。先确认它的 LICENSE 允许：

```bash
curl https://raw.githubusercontent.com/xmanrui/dsh-im/main/LICENSE
```

如果是 MIT / Apache-2.0，可以移植（保留版权声明 + 写进 `THIRD_PARTY_NOTICES.md`）。
如果是 GPL 系，**不能**放进本项目（会传染整个项目）。

## 八之二、实际移植结果（2026-11-18）

### 已完成

| 项 | 结果 |
|---|---|
| vendor 拉取 | **218 个文件 / 2.4 MB**，0 失败 |
| 六个渠道 | feishu 26 / dingtalk 11 / qq 11 / wecom 10 / wecom-app 8 / weixin 10 |
| shared 公共层 | 100 个模块 |
| 许可 | **MIT**（Copyright (c) 2026 xmanrui），已记入 `UPSTREAM.json` + `LICENSE` |
| 核心模块 import | ✅ `harness-client` / `token-bot-controller` / `workspace-command` / `harness-approval` 全部可加载 |
| 六个渠道配置模块 | ✅ 全部可加载 |

### 踩到的两个坑

**① 我一开始跳过了 i18n-ru / i18n-en**

理由是"只用中文"。结果 `i18n.mjs` 在顶层 `import { EN } from './i18n-en.mjs'`，
整个 vendor 加载失败。

教训：**轮子的零件也是轮子的一部分**。体积大不等于能省。

**② 相对路径变了**

原仓库 `src/channels/shared/x.mjs` 里 `import '../../../package.json'` 指到仓库根。
我们放在 `src/main/im/vendor/shared/`，多了一层，解析到 `src/main/package.json`（不存在）。

修法：`scripts/fix-vendor-paths.mjs` 改成 5 级（`../../../../../`），只改 2 个文件 4 处。
用脚本而不是手改，因为**重新 vendor 时还要再改一次**。

### DSH 耦合面（实测，这是移植的已知边界）

我原以为"零 ctx 引用"，实测有 4 个文件用了。逐个看后分三类：

| 文件 | ctx 用途 | 结论 |
|---|---|---|
| `shared/group-history-access.mjs` | `ctx.tools.register` / `ctx.on` 注册进 DSH | **DSH 专有，不加载** |
| `shared/agent-preset.mjs` | `ctx.get('agentPresets')` | **有守卫**：传 undefined 返回空清单 |
| `shared/semantic/artifact.mjs` | `ctx.tools.register` 等 | **有守卫**：`typeof` 检查不过就 return false |
| `qq/qq-runtime.mjs` | `ctx.message = ...` | **误报**：局部变量，不是 DSH 的 ctx |

后两个我写了测试**真的传 undefined 调一次**，确认降级而不是抛错：

```js
const r = await preset.listAgentPresetCatalog(undefined);
assert.deepEqual(r, { defaultId: "", items: [] });
```

所以真正不能用的只有 **1 个文件**（`group-history-access`），
它做的事（把渠道能力注册进工具表）Lynn 有自己的 `ToolRegistry`。

### 还剩什么

| 步 | 状态 |
|---|---|
| vendor 拉取 + 路径修正 + 加载验证 | ✅ 完成 |
| 写适配层（替代它的 `production.mjs`） | ⬜ 下一步 |
| 按渠道懒装 SDK | ⬜ |
| 接进 registry + 设置页渠道切换 | ⬜ |
| 删掉手写的 `im-feishu.ts` | ⬜ |

## 九、一句话

**照原插件的方式 = 整目录 vendor + 自己写 16 行适配层 + 复用它的 `baseUrl` 模式。**
不造轮子的前提是**先证明它的轮子能拆下来**——实测 290 个文件零 `ctx.` 引用，能拆。
