# 风铃 UI 插件契约 v1（冻结版）

冻结日期：2026-11-02（M2-17）。**承诺：v1 冻结后一年内不删除、不改语义**（立项计划书 §5：契约一旦冻结就要兼容一年）。

## 兼容承诺

- **允许（不破坏 v1）**：新增卡槽；manifest 新增可选字段；校验器放宽（如接受新的 source 枚举）；`apiVersion` 仍为 `1` 的一切新增。
- **不允许在 v1 内做**（必须升 `apiVersion: 2` 并双轨过渡）：删除/改名卡槽；删除/改语义 manifest 必填字段；收紧已放行的校验规则导致存量插件失效；改动沙箱强制语义。
- 判定规则写进测试（`tests/contract-frozen.test.mjs`）：以下清单任何一个从代码里消失或改名，CI 直接红。

## 卡槽白名单（U 档第三方插件可注册的 8 个卡槽）

| 卡槽 | 语义 |
|---|---|
| `theme.tokens` | 主题 token 覆盖（只许声明式 Token，禁止脚本） |
| `stage.view` | 图纸主舞台视图 |
| `card.renderer` | 对话卡片渲染器 |
| `avatar.driver` | 形象驱动 |
| `sidebar.item` | 台账侧栏条目 |
| `settings.section` | 设置页分区 |
| `status.bar` | 状态区读数 |
| `composer.action` | 指令台动作按钮 |

## 内置视图卡槽（v1 新增，仅官方）

| 卡槽 | 语义 | 声明要求 |
|---|---|---|
| `stage.console` | 控制台主视图（整屏舞台） | 只许 `source: "official"`；必须声明 `contributes.view`（内置注册表里的 id）；`sandbox` 必须为 `false` |

**为什么不给第三方**：这个卡槽要读会话快照、订阅内核事件、画 Canvas——全在宿主进程里，
iframe 沙箱（U 档）拿不到 `window.lynn`。所以卡槽只开「选一个内置视图」，组件永远来自
`src/renderer/console/registry.ts`，插件代码一行都不执行。第三方声明本卡槽会被 manifest
校验直接拒（`contributes.slots: "stage.console" 只许官方插件声明`），不是靠自觉。

L0 插件占本卡槽时**不读 entry、不下发 html**，只把 `view` 这个名字传给渲染层；
禁用插件 → `<Slot>` 渲染空 → 自动回落值台，不需要在本地记「当前是不是大屏」。

## manifest 必填字段（v1）

`id`（反向域名 `lynn.<作者>.<插件名>`）、`name`、`version`、`apiVersion`（=1）、`tier`（L0/L1/L2/U）、`engines.kernel`（版本闸门，不满足则禁用并提示）。

## 沙箱与权限（v1 语义）

- U 档第三方插件**强制 iframe sandbox**（`allow-scripts` + CSP + 只许 postMessage），entry 必须是 `.html` 且不得跳出插件目录。
- L1 权限声明 `permissions`（`fs`/`net`/`proc`/`secrets`）安装时逐项展示；第三方 `proc` 默认必须 `false`；`secrets` 经内核凭据代理按需下发，插件永不直读。
- 工具权限：三种来源（内置/L1/MCP）同一道 `tool_call` 权限门禁；`allowed-tools` 只做减法。

## Windows 签名与分发说明

安装包代码签名属发布侧配置（需证书）；无签名不影响本契约的任何语义。

## 违反冻结的处理

卡槽清单 / manifest 必填字段 / 权限字段 / apiVersion 的任何破坏性改动，都会被 `tests/contract-frozen.test.mjs` 拦下——改这些之前先升 `apiVersion: 2` 并双轨。
