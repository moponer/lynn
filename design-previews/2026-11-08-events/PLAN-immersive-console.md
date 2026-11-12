# 沉浸控制台（Immersive Console）主题开发方案

> 对象：Lynn `0.0.1`（Electron 45 + React 18 + Vite 5）
> 原型：`design-previews/2026-11-08-events/index.html`（单文件，已两轮真渲染验收）
> 定位：**把「沉浸控制台」做成一个可热拔插的插件模块**，Pi 七包基座零改动
> 编写日期：2026-11-09

---

## 0. 结论摘要

1. **它不该是「壳里的第二个主题」，而该是一个插件。** 项目已有完整四档插件体系（L0 声明式 / L1 进程内 / L2 MCP / U 沙箱 UI），`plugins.toggle` 写 `_state.json` 实现真热拔插，设置页已有插件面板。沉浸控制台按 L0 插件接入，`theme.json` 就是全部产物。
2. **三阶段递进、各自可独立上线回退**：**A** L0 主题插件（0 代码，今天就能装）→ **B** 给 L0 加 `contributes.style`（把形态也交给插件，壳 0 改动）→ **C** 新增 `stage.console` 卡槽 + 官方内置视图注册表（大屏视图可插拔）。A/B 是契约内增量，C 需要 8 人日。
3. 数据**全部来自现有接口**：`session.snapshot`（`board.track / teams / decisions / usage / queue`）+ 9 种 `KernelEvent` + `task.feed`。**零新增 RPC**。
4. 两个真实缺口必须诚实处理：**成员逐句思考正文被吞**、**任务无推送事件**。方案给降级表达，补齐路径单列且明确「这才会动到 pi 数据链」。（原列为第三项的「缓存命中无字段」已由项目补齐：`pi-rpc-host.ts:267-284` → `UsageView.cacheRead/cacheWrite` → `cacheHitRate()`，见 §2.6。）
5. **基座判据只有一条命令**：`npm run check:pi-base` 绿。它守 pi 七包，不守 Lynn 自己的源码。

---

## 1. 边界定义：「基座」指 Pi 那个第三方底盘，不是 Lynn 的源码

### 1.1 唯一硬判据：`npm run check:pi-base`

`scripts/check-pi-base.mjs:2` 开宗明义：

> 架构约束：基座完整不变，新功能一律插件式接入

它守的对象是 **7 个 `@earendil-works/pi-*` npm 包**（`scripts/pi-base-manifest.json`：`pi-agent-core` / `pi-ai` / `pi-codemode` / `pi-coding-agent` / `pi-mcp` / `pi-telemetry` / `pi-tui`，全部 `1.4.0`）。实测输出：「7 个 Pi 基座包完整未改动，无 patch / fork / 内部路径依赖」。四条红线：

| # | 红线 | 位置 | 意味着 |
|---|---|---|---|
| 1 | 无 `patchedDependencies` / `patches/` / git·file 依赖 | `:113-136` | 不能 patch、不能 fork |
| 2 | `package-lock.json` 里 pi 包 integrity 与基线一致 | `:252-254` | 升版本必须显式 `--update` 并 review diff |
| 3 | `node_modules` 各包运行时文件聚合哈希与基线一致 | `:255-261` | 改 `dist/*.js` 立刻红 |
| 4 | 源码不 import pi 内部路径（`/dist` `/core` `/src`） | `:90-110` | 只许包根入口，不把实现细节焊进壳里 |

**所以 `src/main/**` 从来不在基座概念里**——它是 Lynn 的宿主，能力就长在这上面。把「不改基座」写成「不动 `src/main/**`」是错的，那会把插件能力一起锁死。

另外要看清一条容易被误读的实现细节：`findInternalImports()` 只 walk `agent/ src/ tests/ scripts/`（`:105`），且只匹配 `from "@earendil-works/pi-*/dist|core|src/..."`。也就是说——**改 Lynn 业务代码它不拦，碰 pi 它一定拦**。这正是我们要的语义。

### 1.2 但「能改」不等于「该写死在壳里」

Pi 底座能力有限是既定事实（运行时文件数：`pi-agent-core` 6、`pi-ai` 200、`pi-coding-agent` 337，见 `pi-base-manifest.json`）。缺的能力一律按既有设计走插件：**一个能力 = 一个模块目录，`plugins.toggle` 热拔插，不重启、不改 pi**。

所以本方案不采用「加一个 `theme-console.css` + 改 `THEMES` 数组」这条路——那是把主题焊进外壳，与插件化正好相反。

### 1.3 三类能力 → 现有插件档位对照

| 能力 | 落点 | 现状 | 是否要新增机制 |
|---|---|---|---|
| 沉浸配色（16 个语义色） | **L0 主题插件** `contributes.theme → theme.json` | ✅ 已通，零代码 | 否 |
| 主题形态（凹刻章 / 方印 / 密度 / 终端字） | L0 新增可选字段 `contributes.style → theme.css` | ⚠️ 只差一个字段 | 是（契约允许） |
| 大屏视图（地球 / 神经图 / 双流） | 新增卡槽 `stage.console` + 官方内置视图注册表 | ❌ U 档 iframe 拿不到 `window.lynn` | 是（契约允许） |

### 1.4 为什么「加字段 / 加卡槽」不违约

`PLUGIN-CONTRACT.md:7` 明确列出 v1 允许的增量：

> **允许（不破坏 v1）**：新增卡槽；manifest 新增可选字段；校验器放宽（如接受新的 source 枚举）；`apiVersion` 仍为 `1` 的一切新增。

所以 `contributes.style` 与 `stage.console` 都是**契约内合规增量**，不用升 `apiVersion: 2`，不触发 `tests/contract-frozen.test.mjs`。反之，删改现有 8 个卡槽才要双轨过渡——本方案一个都不碰。

### 1.5 验收方式（可机械检查）

```bash
npm run check:pi-base    # 基座唯一判据：必须通过（pi 七包未被改动）
npm run typecheck        # 0 错误
npm run lint:design      # 0 违规
git diff --stat          # 改动面按 §5 各阶段的预算表核对
```

---

## 2. 现状梳理：前后端到底怎么对接

### 2.1 进程与入口

```
main (Electron main)
├── main.ts            600 行   窗口 / 生命周期 / RPC 路由注册
├── preload.ts         ~30 行   contextBridge → window.lynn
├── kernel.ts         4119 行   LLM 会话、卡片、任务、成员调度、事件通知
├── member-runner.ts   330 行   成员单跑（工具 / note / turn / 报告）
├── task-store.ts      411 行   工单权威记录 + 轨迹
├── team-store.ts      586 行   小组与成员编制
├── task-case.ts               卷宗：timeline.jsonl + artifacts/
├── budget.ts                   用量记账 → logs/usage.jsonl
├── settings.ts        305 行   Prefs（用户配置）
├── plugin-host.ts     328 行   L0/L1/L2 加载器：scan / setEnabled / probe
├── plugin-manifest.ts          manifest 校验：tier / engines / slots / permissions
├── plugin-l1.ts       263 行   L1 进程内扩展（jiti 直跑 TS）
├── plugin-set.ts      208 行   插件集快照 / 安全模式 / 回滚
├── plugin-probe.ts    238 行   MCP 隔离试装（一次性进程握手）
├── ui-plugins.ts       91 行   U 档 UI 插件扫描（iframe 沙箱）
└── workshop.ts        325 行   插件工坊：草稿 → 审查 → 晋级

renderer (React)
├── main.tsx           ~36 行   挂载 / 错误上报 / 样式入口
├── App.tsx            651 行   状态中枢：snapshot + 事件 + 主题
├── desk/Desk.tsx     3094 行   现有「值台」视图
└── desk/theme.ts       70 行   主题表与应用
```

### 2.2 三条通道（只有三条）

| 通道 | 前端用法 | 后端实现 | 方向 |
|---|---|---|---|
| RPC | `window.lynn.rpc(method, params)` | `ipcRenderer.invoke("lynn:rpc")` → main 路由 | 请求/响应 |
| 事件 | `window.lynn.onEvent(cb) → 取消订阅` | `ipcRenderer.on("lynn:event")` | 主 → 渲染（单向推） |
| 日志 | `window.lynn.logError(payload)` | `ipcRenderer.send("lynn:log-error")` → `logs/renderer.log` | 渲染 → 主 |

证据：`src/main/preload.ts:8` `exposeInMainWorld("lynn", …)`、`:16` `invoke("lynn:rpc")`、`:20` `on("lynn:event")`、`:25` `send("lynn:log-error")`；类型见 `contract.ts:1054 LynnBridge`。

### 2.3 RPC 面：111 个方法 / 29 个域

按域统计（`grep -oE '"[a-z]+\.[a-zA-Z.]+": \{' src/shared/contract.ts`）：

| 域 | 数量 | 控制台会用到 |
|---|---|---|
| `task` | 8 | `task.feed`（节点流水）、`task.decide`、`task.cancel`、`task.revokeRead` |
| `config` | 8 | `config.prefs`、`config.save` |
| `team` / `calendar` | 7 各 | `team.list`、`team.create`、`team.member.save` |
| `thread` / `session` / `model` / `capture` | 6 各 | `session.snapshot`（唯一快照源）、`session.queue`、`session.abort` |
| `workshop` / `schedule` / `plugins` / `memory` / `app` | 5 各 | `plugins.status`、`app.appearance`（首帧底色）、`app.info`（版本握手） |
| `update` / `providers` / `persona` / `kb` | 4 各 | — |
| `pet` / `msg` | 3 各 | — |
| `window` / `ui` / `trust` / `project` / `permission` / `office` / `files` / `feed` / `evidence` / `decision` | 1 各 | `ui.plugins`、`evidence.open`、`decision.resolve`、`feed.send` |

完整表：`contract.ts:418 RpcContracts`（`RpcMethod = keyof RpcContracts`，`:1046`）。前端实际调用点共 60+ 处，已覆盖上表。

### 2.4 事件面：`KernelEvent` 只有 9 种

来源 `contract.ts:387`。这是控制台做动效的**唯一实时燃料**：

| 事件 | 携带 | 控制台用途 |
|---|---|---|
| `delta` | `text?` / `thinking?` / `cardId?` | 左侧「参谋」数据流：主 agent 的逐句正文与思考 |
| `card` | `card: FeedCard`、`replaced?` | 卡片 upsert（汇报 / 派单 / 审查） |
| `tool` | `badge`、`title`、`meta`、`body?`、`members?`、`jobId?`、`report?` | 右侧「席位」数据流：派单 / 回报 / 工具调用 |
| `turn` | `turn: TurnState` | 风铃状态机（idle/thinking/acting/…） |
| `done` | `tokens` | 单轮收尾，触发用量刷新 |
| `error` | `code?`、`message`、`action?` | 球心红色告警 / 印章 ALERT |
| `thread` | `threadId` | 其他会话有动静 → 只刷新，不 upsert |
| `window` / `capture` | — | 与主题无关 |

**关键事实：没有 task 生命周期事件**（入队 / 捞取 / 分派 / 完成都不推送）。任务视图只能：
`session.snapshot` 全量拉 + `card` / `tool` / `done` 触发的增量重拉 + `task.feed(taskId)` 取单任务流水。

### 2.5 数据面：快照里已经有大屏要的一切

`contract.ts:352 SessionSnapshot`：

| 字段 | 类型 | 控制台对应 |
|---|---|---|
| `board.track` | `TaskTrackItem[]`（id/teamId/title/status/statusNote/member/at/evidenceCount/evidence[]/rejectRounds/parentId/version） | **战局面板 + 态势节点 + 战果抽屉** |
| `board.teams` | `Team[]`（id/name/status/members[{name,role,tools}]） | **席位数据流的「小组 / 成员」标签** |
| `board.decisions` | `Decision[]`（id/from/title/detail/kind=question\|plan\|approval/checks/plan） | **需介入 + 球心告警 + 一键处置** |
| `board.tokensUsed` | `number` | 顶栏读数 / 预算条 |
| `usage` | `UsageView`（turnIn/turnOut/sessionIn/sessionOut/contextTokens/contextWindow） | **用量抽屉** |
| `queue` | `QueueItem[]`（id/text/at） | **来令面板（命令池）** |
| `running` | `string[]` | 席位「在跑」标记 |
| `threads[].counts` | `{active, archived}` | 档案计数 |
| `prefs` | autoStart/trayOnClose/notify/lang/softBudgetTokens | **配置抽屉** |

产出文件：`task.feed(taskId)` + 卷宗 `~/.lynn/tasks/<id>/artifacts/`（`task-case.ts`）。用量明细：`~/.lynn/logs/usage.jsonl`（`budget.ts`）。

### 2.6 两个真实缺口（原写三个，缓存命中已由项目补齐）

| 缺口 | 证据 | 影响 | 降级表达 | 补齐路径（可选，改数据链，不动 pi） |
|---|---|---|---|---|
| ~~缓存命中无字段~~ **已具备，本方案不再降级** | `pi-rpc-host.ts:267-284` 从 Pi stats 读 `tokens.cacheRead / cacheWrite` → `UsageView.cacheRead / cacheWrite / cost`（`contract.ts:206-222`）→ `cacheHitRate()`（`contract.ts:228`）→ 顶栏 `.cache-badge`。**只有 `pi-rpc-host.ts:81` 的 `cost:{...cacheRead:0}` 仍是占位**，那是另一条成本估算路径 | 用量页可直接显示命中率 | 无 | 已打通，不需要补 |
| 成员逐句思考被吞 | `member-runner.ts:261` `onDelta: () => {}` | 右侧席位只能显示 `note` / `tool` / `turn`，**没有逐句正文** | 席位流只呈现「动作 + 回报摘要」，标题不用「思考」 | 把 `onDelta` 转成 `onEvent({kind:"text"})` 并透传到 `tool` 事件 |
| 任务无推送事件 | `KernelEvent` 9 种里无 task 类 | 战局变化靠重拉快照，**不是事件驱动** | 重拉节流 ≥ 400ms，只在 `card`/`tool`/`done` 后触发；不做假进度条 | 新增 `{type:"task", track: TaskTrackItem}` 事件（要升契约版本） |

> 结论：原型演示的是「理想事件流」；真实落地是「快照 + 三条事件推导」。方案按后者设计，缺口在界面上如实标注（原型已内置同一套标注）。

---

## 3. 主题现状与四个合法扩展点

### 3.1 现在只有一张皮

- `desk/theme.ts:10` `THEMES` 只有 `celadon`（青瓦），含 `dark/light` 各 5 个语义色（desk/sheet/blue/seal/brass）。
- `theme.ts:41 applyTheme()` 写 `<html data-theme="celadon" data-mode="dark">`，并把 `desk` 色通过 `app.appearance` 交给壳（防首帧白闪）。
- **但 `dispatch.css` 只在 `data-mode` 上分支**：`:root`（`:11`）是青瓦暗色，`html[data-mode="light"]`（`:88`）是亮色。`dispatch.css:1298` 自己写着：

  > `—— data-theme 仍会写（插件/皮肤契约用），但样式不再依赖它`

  **所以 `data-theme` 目前是个空挂点，没有任何 CSS 消费它。** 这对新主题是利好：写 `html[data-theme="console"]` 就能叠加，不必与青瓦争选择器优先级。
- `skin.ts:11 SKIN_TOKEN_KEYS` 白名单 16 个 token，皮肤包只能覆盖这些、不能新增不能改名。

**这对插件主题是利好**：`data-theme` 挂点未被占用，插件注入的形态 CSS 不与青瓦争优先级。

但这里有个必须提前说清的机制差异，否则 B 阶段写完 CSS 会发现全部不生效：

| 阶段 | 生效方式 | 为什么 |
|---|---|---|
| A · 颜色 | `applyPluginTokens` 直接 `documentElement.style.setProperty` 写 16 个变量 | inline style 优先级高于 `:root` 与 `html[data-mode]` 规则，天然压过青瓦 |
| B · 形态 | 注入 `<style>`，选择器必须收窄 | **`data-theme` 仍是 `celadon`**（`THEMES` 里没有 console 项），拿它做选择器一定匹配不上 |

所以 B 阶段在注入 style 的同时，要给 `<html>` 打一个插件标记 `data-theme-plugin="lynn.theme.console"`，CSS 这样写：

```css
html[data-theme-plugin="lynn.theme.console"] .panel { … }
```

禁用插件即移除该属性，形态整体失效、颜色同时清空，一步回退。

### 3.2 四个扩展点（按侵入度排序）

| # | 扩展点 | 机制 | 侵入 | 能拿到什么 |
|---|---|---|---|---|
| E1 | **L0 `contributes.theme`** | `plugin-host.ts:40 checkThemeFile` → `plugins.list:936` → `App.tsx:627 applyPluginTokens` | 插件目录 2 个 JSON，宿主 **0** | 16 个语义色全覆盖（阶段 A 的全部内容） |
| E2 | **L0 `contributes.style`**（新增可选字段） | 宿主读 `theme.css` 注入 `<style>` + 打 `data-theme-plugin` 标记 | 4 文件 ≈ +40 行 | 形态：凹刻标题章、方印、密度、终端等宽 |
| E3 | **`stage.console` 卡槽**（新增） | `ui-plugin.ts UI_SLOTS` +1；`console/registry.ts` 映射内置组件；`ui-host.tsx:88 Slot` 已存在 | 卡槽表 +1、挂载点 +6、新目录 | 大屏视图（地球 / 神经图 / 双流） |
| E4 | `theme.tokens` 卡槽 / `ui.plugins` | 与 E1 同一条链路，已完全打通 | 0 | 第三方声明式换色 |

> 主题入口有两处来源，不要混：**内置主题**列表是 `THEMES.map` 驱动（`SettingsModal.tsx:1022`）；**插件主题**在「主题插件」区（`:908`）读 `plugins.list`。本方案只走后者，**内置主题列表一行不改**。

### 3.3 为什么磁盘插件（U 档）扛不了大屏

`ui-host.tsx:100 SandboxHtml` 是 `sandbox="allow-scripts"` 的 iframe：**无 same-origin，拿不到 `window.lynn`**，只能收 `action` / `resize` 两条 postMessage，外加三个颜色（desk/sheet/ink）。所以：

- 第三方插件只能做**小挂件**（卡槽 `status.bar` / `composer.action`，`Desk.tsx:205`、`:2116` 已在用）。
- 沉浸控制台要读快照、订阅事件、画 Canvas → **必须是官方内置视图**，走 E3。

### 3.4 设计门禁七条硬约束（`scripts/check-design.mjs`）

**注意：门禁递归扫 `src/renderer/**` 下的 `.css / .ts / .tsx / .html`（`:80-92`）。** 所以阶段 C 的 `console/console.css` 会被检查；而**阶段 B 的插件 `theme.css` 在 `~/.lynn/plugins/**` 下，不在扫描范围**——这不是免检牌照，处理办法见 §5 阶段 B。新主题必须同时满足：

1. **零卡片描边**：不允许任何 `border` / `border-top` 声明（无例外）。
   → 原型的 `border:1px solid` 标题章、面板分隔线，落地时**全部改写成** `box-shadow: inset 0 0 0 1px <color>` 或背景明度台阶。门禁只禁 border，不禁 box-shadow。
2. **每个主题块必须定义 `--blue / --seal / --red / --brass`** 四功能色（`:68-74`）。
3. **禁止 `--accent`**（不设品牌装饰色）。
4. **行内样式零描边**：`border:` 只允许 `0` / `none`（`:92`）。
5. **禁止裸字号**：`font-size: 12px` 直接失败，必须 `var(--fs-*)`，且**最小 10px**（`:103`）。
   → ⚠️ **这是控制台主题最大的落地代价**：原型数据流用了 8px / 9px 的元信息，落地必须抬到 `--fs-label: 10px`。视觉上数据流会变宽变疏，需要重新调列宽与行高（原型 164/176px 列宽按 9px 设计，改 10px 后建议 176/188px）。
6. **禁止文本颜色硬编码**：主题块外写 `color: #xxx` 失败（`:117`）。
7. **对比度阈值**：`fg on bg` 与 `on --sheet`（基线 3.0）都必须达标（`:160-175`）。
   → ⚠️ 控制台最暗的 `--ink-4: #5e7a72` on `--sheet: #101a1a` 实测约 **3.8**，过 3.0 基线；但若用作正文需要 4.5，**只能用于 10px 以下的注释级标签**，M1 阶段必须实测再定值。
8. **引用的 CSS 变量必须有定义**：`var(--ok)` 之类未定义直接失败（`:193`）→ `--ok` / `--term` 必须在同一主题块内声明。

> 这些规则不是障碍，而是把原型的「视觉手法」翻译成工程约束：原型用 border 画线，落地用 inset 阴影画线；原型用 9px 排密，落地用 10px 排松。

---

## 4. 「沉浸控制台」主题定义

### 4.1 Token 映射表（原型 → 基座语义）

原型用自己一套命名，落地必须映射到基座 16 个语义 token，否则组件不复用。

| 控制台意图 | 原型变量 | 基座 token | 暗色值 | 亮色值 |
|---|---|---|---|---|
| 深景底 | `--bg` | `--desk` | `#0b1414` | `#eeeadd` |
| 面板 | `--panel` | `--sheet-2` | `#101a1a` | `#f4f1e6` |
| 浮层 | `--raised` | `--sheet-3` | `#182624` | `#faf7ee` |
| 卡内凹陷 | `--sunken` | `--desk-3` | `#0b1414` | `#e6e2d3` |
| 正文 | `--ink` | `--ink` | `#dfe9e6` | `#262b22` |
| 次级 / 三级 / 四级 | `--ink-2/3/4` | `--ink-2/3/4` | `#a3b8b1 / #8aa29c / #5e7a72` | `#4e5745 / #6a705e / #767c69` |
| 磷光（结构 / 终端） | `--phos` | `--blue` | `#79c2a4` | `#3e6f5b` |
| 朱砂（需拍板） | `--seal` | `--seal` | `#c8443a` | `#b0402f` |
| 赤改（打回） | — | `--red` | `#e0775f` | `#b0453a` |
| 黄铜（预算） | `--amber` | `--brass` | `#c9a227` | `#8a6f1e` |
| 发丝线 | `--line` | `--rule` | `rgba(121,194,164,.14)` | `rgba(55,53,47,.10)` |
| 强线 | `--line-2` | `--rule-soft` → 另用 | `rgba(121,194,164,.30)` | `rgba(55,53,47,.18)` |
| 完成绿（**新增**） | `--ok` | `--ok` | `#6fc187` | `#3f7a4a` |
| 终端前景（**新增**） | `--term` | `--term` | `#a9c8b8` | `#4e5745` |

- `--ok` / `--term` **不在 `SKIN_TOKEN_KEYS` 的 16 个里**，阶段 A 的 `theme.json` 写不进去（`checkThemeFile` 会报「不是允许覆盖的语义 Token」）。它们只能由阶段 B 的 `theme.css` 在自己作用域里定义：

  ```css
  html[data-theme-plugin="lynn.theme.console"] { --ok: #6fc187; --term: #a9c8b8; }
  ```

  这也说明：**16 色白名单是「换肤」的边界，不是「换主题」的边界**。形态与派生色必须走 style 能力，别指望塞进 theme.json。
- 亮色不是「浅色版大屏」，而是「沙盘图纸」：暖纸底 + 墨色文字 + 零光晕（原型已验证 `text-shadow:none`）。

### 4.2 组件清单（原型已验证，逐个可落地）

| 组件 | 数据源 | 落地形态 | 复杂度 |
|---|---|---|---|
| 来令（命令池） | `snapshot.queue` + `feed.send` | 列表 + 空态雷达动效 | 低 |
| 战局（任务总览） | `board.track` 分组（`teamId`）+ `threads[].counts` | 列表 + 归档区 | 中 |
| 态势（节点图） | `board.track` 节点 + `track[].parentId` 边 | Canvas 2D（复用原型 draw 循环） | 高 |
| 风铃（状态核心） | `KernelEvent.turn` | 纯 CSS 环 + 方印 | 中 |
| 席位（右侧数据流） | `tool` 事件的 `members/meta/body` + `board.teams` | 等宽行 + 行级淡出 | 中 |
| 参谋（左侧数据流） | `delta.thinking` / `delta.text` | 同上 | 低 |
| 产出（产物柜） | `task.feed` + `artifacts/` | 卡片墙 + 类型图标 | 中 |
| 战果抽屉 | `task.feed` 的 timeline | 右侧 side panel + 4 tab | 中 |
| 军印（状态章） | `turn` + `decisions` | 方形石印 + 优先级 | 低 |
| 球心告警 | `decisions[kind=approval/plan]` | 红色脉冲 + 一键 `decision.resolve` | 中 |

### 4.3 与现有视图的关系

**同一份数据，两种表达，靠卡槽切换**：

```
session.snapshot + KernelEvent
        │
        ├── Desk.tsx（值台：聊天流 + 悬挂卡片）   ← 现有，一行不改
        └── console/ConsoleDesk.tsx（控制台：态势 + 双流）  ← 阶段 C 新增，经 stage.console 卡槽挂载
```

两个视图共享 `App.tsx` 里已拉好的 `snap` 与事件订阅，**不重复请求后端**。禁用 `stage.console` 插件后 `<Slot>` 渲染空，自动回到 Desk。

---

## 5. 落地方案：三阶段，全部走插件

### 5.1 总览

```
┌──────────────────────────────────────────────────────────────────┐
│  Pi 七包基座（check:pi-base 守）        完全不动，一个字节不改   │
└──────────────────────────────────────────────────────────────────┘
                              ↑ 只允许调用包根入口
┌──────────────────────────────────────────────────────────────────┐
│  Lynn 宿主（可改，但只加「加载能力」，不加「具体主题」）          │
│  plugin-manifest · plugin-host · plugins.list · 一个挂载点        │
└──────────────────────────────────────────────────────────────────┘
                              ↑ 读
┌──────────────────────────────────────────────────────────────────┐
│  插件模块  ~/.lynn/plugins/lynn.theme.console/                   │
│  plugin.json · theme.json · theme.css（阶段 B 才出现）            │
└──────────────────────────────────────────────────────────────────┘
```

**关键原则：壳里不出现任何 console 专用色值、组件名、视图路径。** 壳只知道「有个启用的主题插件要注入」，不知道它长什么样。换主题 = 换插件目录，不是改代码。

---

### 5.2 阶段 A · L0 主题插件（0 代码，0.5 人日）

产物只有两个 JSON，落盘即生效。

`~/.lynn/plugins/lynn.theme.console/plugin.json`

```json
{
  "id": "lynn.theme.console",
  "name": "沉浸控制台",
  "version": "1.0.0",
  "apiVersion": 1,
  "tier": "L0",
  "engines": { "kernel": "^0.0.1" },
  "source": "official",
  "contributes": { "theme": "theme.json" }
}
```

`~/.lynn/plugins/lynn.theme.console/theme.json`（键必须落在 `SKIN_TOKEN_KEYS` 的 16 个里，值必须是颜色）

```json
{
  "name": "沉浸控制台",
  "dark": {
    "--desk": "#0b1414",
    "--desk-2": "#101a1a",
    "--desk-3": "#0b1414",
    "--sheet": "#101a1a",
    "--sheet-2": "#101a1a",
    "--sheet-3": "#182624",
    "--ink": "#dfe9e6",
    "--ink-2": "#a3b8b1",
    "--ink-3": "#8aa29c",
    "--ink-4": "#5e7a72",
    "--blue": "#79c2a4",
    "--seal": "#c8443a",
    "--red": "#e0775f",
    "--brass": "#c9a227",
    "--rule": "rgba(121,194,164,.14)",
    "--rule-soft": "rgba(121,194,164,.07)"
  },
  "light": {
    "--desk": "#e6e2d4",
    "--desk-2": "#eeebdf",
    "--desk-3": "#d9d5c5",
    "--sheet": "#eeebdf",
    "--sheet-2": "#f4f1e6",
    "--sheet-3": "#faf7ee",
    "--ink": "#262b22",
    "--ink-2": "#4e5745",
    "--ink-3": "#6a705e",
    "--ink-4": "#767c69",
    "--blue": "#3e6f5b",
    "--seal": "#b0402f",
    "--red": "#b0453a",
    "--brass": "#8a6f1e",
    "--rule": "rgba(55,53,47,.10)",
    "--rule-soft": "rgba(55,53,47,.06)"
  }
}
```

**生效链路（全部现成，零改动）**

```
plugin-host.ts:105  scan()            → 逐个插件校验
plugin-host.ts:40   checkThemeFile()  → 16 键白名单(:56) + 颜色正则(:38)
contract.ts:936     plugins.list      → 返回 theme.dark / theme.light
SettingsModal:908   「主题插件」区    → 用户点启用
contract.ts:954     plugins.toggle    → PluginHost.setEnabled(:212) 写 _state.json
App.tsx:627         onApplyThemeTokens → theme.ts:60 applyPluginTokens() 写 CSS 变量
App.tsx:152         换基础主题        → 先清空插件覆盖，不会串味
```

热拔插是真的：改 `_state.json` 或点开关即可，不重启进程、不改代码、不改 pi。

**阶段 A 必须承认的限制**：`checkThemeFile` 的 `COLOR_RE`（`plugin-host.ts:38`）只放行颜色值，`SKIN_TOKEN_KEYS`（`skin.ts:11`）只有 16 个颜料键，**没有任何字号、间距、圆角、布局键**。所以 A 阶段只能换色，形态一点不改——这正是阶段 B 的动机，不是缺陷。

**验收**：`plugins.list` 列出该插件且 `theme.dark` 16 键齐全；启用后 `--desk` 变 `#0b1414`，禁用后回落青瓦；`git diff` **为空**（真零代码）；`check:pi-base` 绿。

---

### 5.3 阶段 B · 给 L0 加 `contributes.style`（1.5 人日）

**目标**：把「标题章凹刻 / 方印 / 密度 / 终端等宽正文」也搬进插件目录，壳里仍然 0 个色值、0 个组件名。

改动四处，全在 Lynn 宿主，pi 不动：

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/main/plugin-manifest.ts` | `contributes` 加可选 `style?: string`，校验 `.css` 结尾 | +6 |
| `src/main/plugin-host.ts` | `PluginView` 加 `styleCss?: string`，读文件 + 大小上限（建议 256KB）+ 路径 contain 校验 | +18 |
| `src/shared/contract.ts` | `plugins.list` result 加可选 `style?: string`（放宽，不破 v1） | +2 |
| `src/renderer/App.tsx` | 启用插件带 style 时注入 `<style id="plugin-style-{id}">`，禁用即移除 | +14 |

`UI_SLOTS`、`theme.tokens` 卡槽、`applyPluginTokens` 都不需要动。

**插件侧产物**：目录里多一个 `theme.css`

```css
/* 叠加在既有组件上，靠属性选择器收窄，不改 dispatch.css 既有规则 */
html[data-theme="console"] .panel {
  background: var(--desk-2);
  box-shadow: inset 0 1px 0 rgba(121,194,164,.07);      /* 门禁：不用 border */
}

html[data-theme="console"] .cap {
  font-family: var(--f-mono);
  font-size: var(--fs-label);                            /* 门禁：禁裸字号，最小 10px */
  background: var(--desk-3);
  box-shadow: inset 0 1px 2px rgba(0,0,0,.42), inset 0 0 0 1px var(--rule);
  border-radius: 2px;
}
```

**门禁差异必须说清**：`check-design.mjs` 递归扫的是 `src/renderer/**`（`:80-92`），**插件目录不在扫描范围**。这不是免检牌照——同一套规范（零 border / 最小 10px / 四功能色齐 / 对比度 3.0）必须在插件 CSS 里手工遵守。建议把这条落进插件准入流水线 `workshop.ts:168 reviewDraft()`：那本来就是管插件质量的地方，天然该管这个。

**验收**：禁用插件后青瓦逐像素不变；启用后 `src/renderer/**` 的 `border` 计数仍为 0；两次 toggle 无 `<style>` 残留（`document.querySelectorAll('[id^="plugin-style-"]').length` 归零）。

---

### 5.4 阶段 C · 新增 `stage.console` 卡槽 + 官方内置视图（8 人日）

**为什么必须新增机制**：`SandboxHtml`（`ui-host.tsx:100+`）是 `sandbox="allow-scripts"` 的 iframe，无同源，只下发三个颜色（desk/sheet-3/ink）、只收 `action`/`resize` 两类 postMessage。**拿不到 `window.lynn`，读不到快照、订阅不到事件、画不了 Canvas。** U 档插件注定只能做小挂件（`status.bar` / `composer.action`，`Desk.tsx` 已在用）。

所以视图卡槽走「官方内置视图注册表」，不走 iframe：

```
src/renderer/console/            ← 插件化的「视图实现」住这里
├── registry.ts                  view id → React 组件 映射（唯一注册表）
├── ConsoleDesk.tsx              六面板栅格 + 抽屉 + 顶栏
├── useConsoleFeed.ts            delta/tool/card/turn/done/error → 双流 + 状态机
├── useTrackGraph.ts             board.track → 节点/边/簇（含 parentId）
├── Field.tsx                    Canvas 2D：深景 + 球面 + 神经图
├── Stream.tsx                   两侧等宽数据流（opacity 阶梯 + 顶部顶出）
├── Seal.tsx                     方形军印四态
└── console.css                  视图局部样式（继续零 border）
```

插件只声明「我要占 `stage.console` 卡槽、用注册表里的 `console` 视图」：

```json
"contributes": { "slots": ["stage.console"], "view": "console" }
```

`App.tsx` 唯一挂载点（约 6 行）：

```tsx
<Slot
  slot="stage.console"
  render={(p) => (p.view === "console" ? <ConsoleDesk snap={snap} onExit={...} /> : null)}
/>
```

**这个设计的关键好处**：禁用插件 → `<Slot>` 渲染空 → 自动回落 Desk，不留幽灵状态；`localStorage` 不用记「当前是不是大屏」，因为启用状态本身就是 `_state.json`。这也顺带解决了原方案用 `localStorage.lynn.view` 暗开关会把用户卡在空视图里的问题。

**验收**：`git diff src/renderer/desk/Desk.tsx` 为空；禁用卡槽插件后回 Desk 且无残留 `requestAnimationFrame` / 定时器；控制台 60fps（`perf:standby` 同款采样）；双流保留上限 400 行，事件堆积内存不涨。

---

### 5.5 改动面预算汇总

| 阶段 | 新增文件 | 宿主改动 | Pi 基座 | 人日 |
|---|---|---|---|---|
| A · L0 主题插件 | 2（`plugin.json` / `theme.json`） | **0** | 0 | 0.5 |
| B · `contributes.style` | 1（`theme.css`） | 4 文件 ≈ +40 行 | 0 | 1.5 |
| C · `stage.console` 卡槽 | 8（`console/**`） | 卡槽表 +1、挂载点 +6 | 0 | 8 |

---

## 6. 数据映射表（落地时照这个接）

| 界面元素 | 数据 | 刷新方式 | 缺口 |
|---|---|---|---|
| 来令列表 | `snapshot.queue` | `done` / `card` 后重拉 | — |
| 来令空态雷达 | 无数据 | 纯 CSS 动效 | — |
| 战局分组 | `board.track` 按 `teamId` | 快照重拉（≥400ms 节流） | 无推送，见 2.6 |
| 战局归档区 | `board.track.filter(status=archived\|done)` | 快照重拉 | — |
| 态势节点 | `track[].id/title/status/statusNote/member` | 同上 | — |
| 态势边 | `parentId` + `teamId` | 同上 | — |
| 节点焦点卡 | `track[i]` + `evidenceCount` | 点击时读 | — |
| 军印状态 | `track[].status` 优先序：`decisions>rejected>approved>pending` | 同上 | — |
| 球心告警 | `decisions[].kind in {plan,approval}` | 同上 | — |
| 一键处置 | `decision.resolve(id, …)` | RPC | — |
| 席位数据流 | `tool` 事件 `members[].name/role`、`meta`、`body` | 事件即时 | **无逐句正文** |
| 参谋数据流 | `delta.thinking` / `delta.text` | 事件即时 | — |
| 风铃状态 | `turn` 事件 | 事件即时 | — |
| 产出柜 | `task.feed(taskId)` 的 artifacts | 任务选中时拉 | — |
| 战果抽屉 · 结果 | `task.feed` timeline 尾部 | 抽屉打开时拉 | — |
| 战果抽屉 · 流水 | `task.feed` 全量 | 同上 | — |
| 用量 | `snapshot.usage`（含 `cacheRead / cacheWrite / cost / contextPercent`）+ `board.tokensUsed` | `done` 后重拉 | 缓存命中已有，`cacheHitRate()` 见 `contract.ts:228` |
| 配置 | `config.prefs` → `config.save` | 打开时拉 | — |
| 版本握手 | `app.info` | 启动一次 | — |

---

## 7. 任务清单

### A · L0 主题插件（0.5 人日）— 已落地并通过实测

- [x] A-1 建 `~/.lynn/plugins/lynn.theme.console/`（仓库内留一份样例 `design-previews/2026-11-08-events/plugin-sample/`）
- [x] A-2 写 `plugin.json`：`tier: L0` / `apiVersion: 1` / `source: official` / `contributes.theme` + `contributes.style`
- [x] A-3 写 `theme.json` 暗色 16 键（色值取 §4.1 映射表）
- [x] A-4 写 `theme.json` 亮色 16 键（沙盘图纸，零光晕）
- [x] A-5 对比度复测（见 §10.3）：暗色 `--ink-4` 3.80、亮色 `--ink-4` 3.62 均过 3.0；亮色原值 `#949a86` 实测只有 2.43，已改 `#767c69`
- [x] A-6 实测 `plugins.list` 能列出：`theme 16+16 键 / errors=[]`（§10.4）
- [x] A-7 实测 `plugins.toggle` 生效与回落：`_state.json` 落盘、指纹 `f40a266e8ba7 ↔ e3b0c44298fc`（§10.4）
- [x] A-8 验收：`check:pi-base` 绿、宿主 0 行改动、恢复后 token 逐项回原值

### B · `contributes.style`（1.5 人日）— 已落地，6 文件 ≈83 行

- [x] B-1 `plugin-manifest.ts` 加 `contributes.style?: string` + 必须是 `.css`（`:56` 类型、`:179` 校验）
- [x] B-2 `plugin-host.ts` 加 `checkPluginCss()`（256KB 上限 / 路径 contain / 禁 `@import`·`javascript:`·`expression()`·`url(file:)`），`PluginView.style` 下发 CSS 原文
- [x] B-3 `contract.ts` `plugins.list` result 加可选 `style?: string`（`:967`）
- [x] B-4 `theme.ts` 加 `applyPluginStyle(id, css)`：注入单例 `<style id="lynn-plugin-style">` + 给 `<html>` 打 `data-theme-plugin`；换基础主题时一并卸载（`App.tsx:153`）；`SettingsModal` 应用/恢复两个按钮都接
- [x] B-5 插件侧 `theme.css`（4209 字符 / 26 处属性作用域）：标题章凹刻 / 卡片方角 / 按钮凹陷 / 输入内凹 / 长文本等宽 / 缓存徽标同族（零 border、最小 10px）
- [ ] B-6 `workshop.ts:168 reviewDraft()` 加 style 静态检查（禁 border / 禁裸字号 / 禁 `--accent`）—— **未做**：本轮走的是手写插件目录，没经工坊准入流水线；C 阶段前补
- [x] B-7 契约测试复跑：`npm test` 375 / 375 全绿（新增可选字段不属破坏）
- [x] B-8 验收：恢复后 token 逐项回原值、`<style>` 无残留、`data-theme-plugin` 清空、`lint:design` 0 违规

### C · `stage.console` 卡槽 + 内置视图 — 已落地，8 新文件 + 6 文件改动（2026-11-09）

- [x] C-1 契约：`plugin-manifest.ts` / `ui-plugin.ts` 两处 `UI_SLOTS` 加 `stage.console` + `INTERNAL_ONLY_SLOTS`；`contributes.view?: string`（`VIEW_ID_RE = /^[a-z][a-z0-9-]*$/`）
- [x] C-2 `src/renderer/console/registry.ts`：view id → 组件（`CONSOLE_VIEWS` / `consoleViewOf` / `consoleViewIds`），未知 id 渲染空
- [x] C-3 `ConsoleDesk.tsx`：顶栏 / 三列（待判+台账 / 球面 / 产出柜+用量）/ 底栏指令行
- [x] C-4 `useConsoleFeed.ts`：`tool`·`card`·`delta`·`turn`·`done`·`error` 六类 → 数据流行 + `SealedPhase` 状态机；rAF 合帧、400 行封顶、卸载清帧
- [x] C-5 图归约并入 `Field.tsx`（`nodesOf` + `layoutClusters`）：工单→簇、成员/阶段→节点、环上布点 + 最近邻连线；**未单建 `useTrackGraph`**（每帧读 ref，不做 React state，避免 60fps 重渲染）
- [x] C-6 `Stream.tsx`：等宽 + `>` 提示符 + 行尾光标 + `nth-last-child` opacity 阶梯；**字号按门禁走 `--fs-label`（12px）**，列宽 148/158、单行 clamp；无事件时整列不渲染
- [x] C-7 `Seal.tsx`：七态（listen/pick/analyze/dispatch/decide/intervene/done）映射四功能色，`decide`/`intervene` 抢优先级
- [x] C-8 `App.tsx` 挂载：`useUiPlugins` → `pluginsForSlot("stage.console")` → `consoleViewOf(view)`；无插件即渲染 `DeskView`，`consoleHidden` 只是"回值台"的临时态（附悬浮回入口）
- [x] C-9 Canvas：离屏静态球层（星点/大气/纬线）+ 每帧自转层（经线/陆块/地面站）+ 神经图（簇/节点/粒子/涟漪/射线）+ 标签避让（guard 176/186）+ hover/点击锁定
- [x] C-10 卡点告警：`blocked`/`unblock` → 簇红脉冲 + `intervene` 印章闪烁；**一键处置走决策卡按钮**（`decision.resolve`），未做球心弹层
- [x] C-11 抽屉 4 个：战果 / 用量 / 配置 / 档案（流水页签合并进两侧数据流，未单开）
- [x] C-12 用量页读 `UsageView` 真实值：`cacheRead/cacheWrite` 已接入（方案里"未接入"的结论已过期），命中率分母为 0 时显示 `—` 并说明原因
- [x] C-13 空态：无决策 → 雷达扫描环；无工单 → `NO ACTIVE TASK`
- [x] C-14 三轮真渲染评审（不是两轮）：球径 0.36→0.30→0.28、单簇角度改 -1.15、印章改 column-reverse 避让图例、产出柜回单列、决策面板 46%→62% 自适应、浅色球面 #e8e5d8→#efefec（去黄去脏）、暗斑 alpha 0.5→0.22
- [x] C-15 验收：`Desk.tsx` 零改动（`grep console src/renderer/desk/Desk.tsx` 无命中）；三条清理路径全在（Field cancelAnimationFrame / ConsoleDesk clearInterval / useConsoleFeed cancelAnimationFrame）

### 可选项（会改数据链与契约，单独立项，不在本方案内）

> 这三项都不需要动 pi 包，但会改 Lynn 自己的事件/用量契约，因此不混进主题方案。

- [ ] P-1 成员流式正文透传：`member-runner.ts:261 onDelta` → `onEvent({kind:"text"})`
- [ ] P-2 缓存命中：解析 `prompt_tokens_details.cached_tokens` → `usage.jsonl` → `UsageView`
- [ ] P-3 任务事件：`KernelEvent` 新增 `{type:"task"}`（需升契约版本 + 双轨过渡）

---

## 8. 验收与回退

| 关口 | 命令 / 动作 | 通过标准 |
|---|---|---|
| **基座** | `npm run check:pi-base` | 通过：7 个 pi 包运行时哈希与基线一致、无 patch / fork / 内部路径 import |
| 类型 | `npm run typecheck` | 0 错误 |
| 设计 | `npm run lint:design` | 0 违规（零 border / 四功能色齐 / 无 `--accent` / 无裸字号） |
| 契约 | `tests/contract-frozen.test.mjs` | 绿（新增可选字段与新增卡槽不属破坏） |
| 构建 | `npm run build` | 成功 |
| 改动面 | `git diff --stat` | 按 §5.4 预算表核对；A 阶段必须为空 |
| 回退 A/B | `plugins.toggle` 禁用该插件 | 主题即时回落青瓦，`<style id="plugin-style-*">` 清零 |
| 回退 C | 禁用 `stage.console` 插件 | 自动回落 Desk，无残留 rAF / 定时器 |

**灰度策略**：A 阶段直接随版本发出一个官方 L0 插件样例（默认不启用，用户在设置里开）；B/C 各自独立开关，任何阶段出问题只需禁插件，不需要回滚版本。

---

## 9. 不做的事（明确边界）

1. **不新增业务 RPC**：控制台只用现有 111 个方法里的 12 个。B 阶段只放宽 `plugins.list` 返回（加可选 `style`），不新增方法。
2. **不改 `KernelEvent`**：9 种事件够用；任务状态靠快照重拉，不做假事件、不做假进度条。
3. **不改 `Desk.tsx`**：值台保留原样，两个视图并存，靠卡槽切换。
4. **不引入第三方图 / 3D 库**：Canvas 2D 足够（原型已用纯 Canvas 跑 60fps），体积零增长。
5. **不造假数据**：成员逐句思考被吞、任务无推送事件两处缺口在界面上写明依据，宁可少画一块。
6. **不碰 pi 七包**：`node_modules/@earendil-works/**` 不改、`pi-base-manifest.json` 不重生成、任何代码不 import pi 内部路径。`check:pi-base` 是唯一判据。
7. **不把主题焊进壳里**：壳里不出现 console 专用色值、组件名、视图路径。换主题 = 换插件目录，不是改代码——这是插件化设计的底线。

---

## 10. 实测记录（2026-11-09，真跑，不是估算）

### 10.1 基座红线

```
$ node scripts/check-pi-base.mjs
[pi-base] 通过：7 个 Pi 基座包完整未改动，无 patch / fork / 内部路径依赖
```

### 10.2 插件样例校验（调项目真实校验器，不是手写规则）

样例已生成：`design-previews/2026-11-08-events/plugin-sample/lynn.theme.console/{plugin.json, theme.json}`

```json
{
  "manifest": { "ok": true, "issues": [] },
  "theme":    { "ok": true, "issues": [], "darkKeys": 16, "lightKeys": 16 }
}
```

即 `tier: L0` + `contributes.theme` 的 manifest 通过 `checkManifest`；16 个键全落在 `SKIN_TOKEN_KEYS` 白名单内；每个值都是合法颜色。**零代码、零宿主改动、零 pi 改动。**

### 10.3 对比度（WCAG，门禁基线 3.0 / 正文 4.5）

| 模式 | 组合 | 比值 | ≥3.0 | ≥4.5 |
|---|---|---|---|---|
| 暗 | `--ink` on `--sheet` | 14.30 | ✅ | ✅ |
| 暗 | `--ink-2` | 8.48 | ✅ | ✅ |
| 暗 | `--ink-3` | 6.52 | ✅ | ✅ |
| 暗 | `--ink-4` | 3.80 | ✅ | ❌ 仅注释级 |
| 暗 | `--blue` | 8.50 | ✅ | ✅ |
| 亮 | `--ink` | 12.12 | ✅ | ✅ |
| 亮 | `--ink-2` | 6.34 | ✅ | ✅ |
| 亮 | `--ink-3` | 4.30 | ✅ | ❌ 接近 |
| 亮 | `--ink-4` | 3.62 | ✅ | ❌ 仅注释级 |
| 亮 | `--blue` | 4.84 | ✅ | ✅ |

**首版翻车记录**：亮色 `--ink-4` 原取 `#949a86`，实测 **2.43**，连 3.0 基线都不过；`--ink-3 #7c8270` 只有 3.33。已改 `#767c69`（3.62）与 `#6a705e`（4.30）。这也是 A 阶段必须先跑校验器、再谈视觉的原因。

### 10.4 A / B 阶段已实测（2026-11-09，真跑）

**A 阶段（L0 插件，宿主 0 行改动）**

- 装进 `~/.lynn/plugins/lynn.theme.console/` 后 `PluginHost.scan()` 立即发现：`enabled=true / theme 16+16 键 / style 4209 字符 / errors=[]`，**无需重启**。
- `setEnabled(false)` → `enabled=false`、指纹 `f40a266e8ba7 → e3b0c44298fc`（空集）、`_state.json` 落盘 `{"lynn.theme.console": false}`；再启用 → 指纹原值复现、`count=1`。**指纹是确定性哈希，同一套插件集必回同一值**，可用来做回滚校验。
- 真删目录 → 立刻扫不到（真热卸载）；重装 → 立刻回来；第三方 L0（去掉 `source`）在干净 root 下仍默认启用（默认关闭只针对 L1）。
- 坏插件隔离：同目录放一个坏 manifest 的邻居，好的照常列出，`errors` 只报坏的那条。

**B 阶段（`contributes.style`，改 6 个文件≈83 行）**

- Electron 45 真渲染、点设置页「沉浸控制台」按钮走完整 UI 链路，实测：

| 探针 | 应用前（青瓦） | 应用后 | 恢复后 |
|---|---|---|---|
| `html[data-theme-plugin]` | `null` | `lynn.theme.console` | `null` |
| `<style id="lynn-plugin-style">` | 无 | 有（4209 字符） | 无 |
| `--desk / --sheet / --ink-2` | `#0a0d0f / #151d22 / #a3adb3` | `#0b1414 / #101a1a / #a3b8b1` | 回原值 |
| `--term`（形态层派生） | 空 | `#a3b8b1` | 空 |
| `.panel-h .t` | Archivo 14px / 无阴影 | **IBM Plex Mono 10px / 凹刻内阴影** | 回原值 |
| `.mcard` | 圆角 5px + 投影 | **圆角 2px + 发丝内描边** | 回原值 |

- CSS 准入实测：`@import` / `javascript:` / `expression()` / `url(file:)` 四类全部拒绝；坏 CSS 的邻居不受连累（只报 `形态层不得使用 @import`）。
- 两处必须知道的落地坑：
  1. **`data-theme` 不会变成插件 id**（仍是 `celadon`），所以形态 CSS 只能用 `html[data-theme-plugin="<id>"]`；没有这个标记，写完一条都不生效。
  2. **凹刻章的底必须比背景暗**：首版把 `--desk-3` 设成与 `--desk` 同值，章只剩一圈描边、看不出凹陷；改 `#070e0e` 后成立。
- 中文标题靠字体区分不出来（等宽字体对中文无效），实际区分靠**底色 + 内阴影 + 字号**三件套。

### 10.5 A / B 阶段验收命令结果

```
npm run typecheck      ✅ 0 错误（renderer + main 两段）
npm run lint:design    ✅ 零描边 / 四功能色齐 / 无装饰色 / 变量引用全有定义
npm run check:pi-base  ✅ 7 个 Pi 基座包完整未改动
npm test               ✅ 375 / 375 通过
```

### 10.6 C 阶段实测（2026-11-09，真跑）

**卡槽验收脚本**（`node design-previews/2026-11-08-events/plugin-sample/verify-console.mjs`，12/12 通过）：

| 断言 | 结果 |
|---|---|
| 官方 L0 能占 `stage.console` | PASS |
| 纯主题 L0 不进 UI 列表（列表里只有 console 那一条） | PASS |
| 第三方声明 `stage.console` 被拒 | PASS — `contributes.slots "stage.console" 只许官方插件声明` |
| 占卡槽不给 `view` 被拒 | PASS |
| `view` 透传为 `console` / 默认启用 / 不带 iframe 文档 | PASS ×3 |
| 停用后 `enabled=false`（渲染层据此卸载视图） | PASS |
| 安全模式下官方仍按声明加载 | PASS |
| `checkManifest`：无 view / 合法 / view id 非法（`Console/../x`） | PASS ×3 |

**真渲染走查**（Electron 45，1600×1000，`LYNN_PREVIEW_CONSOLE=1`）：深色 4 轮、浅色 3 轮。每轮修的实据：

| 轮 | 看到的问题 | 改法 |
|---|---|---|
| 1 | 球贴脸、两侧数据流被挤到极边缘；军印状态句与图例同一水平线；右栏用量面板撑到 46% 高 | R `min(W*.40,H*.53)`→`0.36/0.5`；印章容器改 `column-reverse` |
| 2 | 单簇落在正上方压住球心铭牌；决策面板 46% 把第三条切成半截；产出柜 1 张卡 + 大片空 | 单簇角度改 `-1.15`；`max-height` 46%→62% 且 `flex: 0 1 auto` |
| 3 | 数据流每行两行 clamp 导致末行被 `bottom` 裁切；`工具 工具`（badge 被当人名重复） | `-webkit-line-clamp: 1`；无成员时 `who` 留空 |
| 4 | 浅色球面 `#e8e5d8` 在 Notion 白纸上发黄显脏；暗斑 alpha 0.5 像一块污渍 | 球面改中性 `#efefec`，暗斑 `#e6e6e1@0.22` + 模糊半径 ×1.6，经线 alpha .05→.10 |

**契约测试的两处收紧**（不是放松，护栏换成更准的形状）：

- `ui-plugin.test.mjs` 原断言 `UI_SLOTS` 恰好 8 项 → 改为「冻结 8 项按原顺序全保留」+「新增项必须显式登记为 `["stage.console"]`」。删/改/重排照样红，偷偷加卡槽也照样红。
- `ui-plugins.test.mjs`「只处理 U 档」拆成四条：L0 无卡槽静默跳过 / L0 占内置卡槽进列表但不带 `html` / L0 声明需要渲染的卡槽被拒（`L0 无组件代码`）/ L1·L2 不进列表。

新增 `checkUiPlugin` 规则：**L0 只能占内置视图卡槽**。理由——L0 是声明式产物，没有组件代码；声明 `status.bar` 这类卡槽等于要求宿主执行它没有的东西，必须升 U 档。

### 10.7 尚未实测

- 窄窗（< 1000px）下控制台三列折叠成单列后的滚动行为（CSS 已写：`display:none` 掉左右栏 + 隐藏双流，未截图验证）
- 真机 60fps 采样（当前只目测，未跑 `perf:standby` 同款采样）
- `decision.resolve` 在控制台里点「批准开工」的端到端回写（按钮已接 `onDecisionResolve`，未开真机点）
