# 插件索引

> 分类：**内置官方**（随包分发）/ **示例**（仓库 `examples/`，学习用）/ **社区**（投稿后收录）。来源与准入结论在插件面板可见；未过审 / 影子态的插件不会出现在这里。

## 内置官方

| 插件 | 档 | 说明 |
|---|---|---|
| `lynn.tool.dice` | L1 | 官方 L1 示例：掷骰工具（jiti 直跑，展示 registerTool 契约） |
| 主题：夜航 / 纸墨 / 青瓦 | L0 | 三主题 × 亮暗（内置于渲染层 Token，非插件目录） |

## 示例（`examples/`，可当模板复制）

| 示例 | 档 | 位置 |
|---|---|---|
| `lynn.theme.dusk` | L0 主题 | `examples/plugins/lynn.theme.dusk/` |
| `lynn.tool.dice` | L1 工具 | `examples/plugins/lynn.tool.dice/` |
| `lynn.demo.hello` | U 界面组件 | `examples/ui-plugins/lynn.demo.hello/` |
| `echo-server` | L2 MCP | `examples/mcp/`（含 `mcp.example.json` 配置样例） |

## 社区

暂未开放投稿（等待签名信任链与索引审核流程落地，如实注明——不是技术未就绪，是发布流程未开）。

想先自己写一个？→ [插件开发指南](./plugin-guide.md)。造一个的门槛是：复制示例目录 → 改 manifest 的 id / name / contributes → 放进 `~/.lynn/plugins/` → 重启。

## 工坊（她帮你造）

你也可以让风铃把一个重复流程固化成插件：她写规格 → 派「插件工程师」成员在草稿区实现 → 准入审查 → L0 技能她可自启用（记审计）、L1/L2 等你在插件面板点启用。对话里说「把这套流程做成技能」即可。

下页：[隐私说明](./privacy.md) · [发布与签名](./release.md)
