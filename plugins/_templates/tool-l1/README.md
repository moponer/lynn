# 示例工具（L1 模板）

演示**带代码的插件**：注册两个工具，一个有私有状态目录。

## 契约（三条，记住就够）

1. **默认导出** `activate(api)`；
2. `api.registerTool({ name, description, parameters, execute })`；
3. `name` 用**短名**，运行时自动加前缀（`word_count` → `lynn_template_tool_word_count`）。

## `api` 上有什么

| 成员 | 说明 |
|---|---|
| `registerTool(def)` | 注册工具 |
| `dataDir` | 插件私有状态目录，**活过升级**（安装目录会被重装覆盖） |
| `log(...)` | 写日志（转发到内核日志） |

## 三个不要

| 不要 | 为什么 |
|---|---|
| 模块顶层做副作用 | `activate` 之前进程可能只是被加载 |
| `require("node:child_process")` | manifest 是 `proc: false`；要子进程请做 L2 |
| 读 `~/.lynn` 凭据 | `permissions.secrets` 走内核代理，插件永不直读 |

## 校验 + 试跑

```bash
node scripts/check-plugin-package.mjs plugins/_templates/tool-l1
node scripts/probe-l1-isolation.mjs      # 看隔离边界（改权限前必看）
```

## 注意

`permissions` 目前**只校验不执行**（25 章第 7 节的已知缺口）。
写的时候就要按声明的约束自律——因为内核还没强制。
