# 示例 MCP（L2 模板）

演示 **L2 档**：插件不写代码，只声明"怎么起一个 MCP server"，能力由那个进程按标准协议提供。

## 为什么有 L2 这一档

L1 是"在我们管理的隔离进程里跑 TS"。它对重依赖不友好：

| 问题 | L2 怎么解决 |
|---|---|
| 浏览器驱动 / Office 引擎崩了，插件整块不可用 | 它是独立进程，崩了只影响自己 |
| 社区已有现成 MCP server，重写没意义 | 直接复用 |
| 依赖别人的运行时（Python / Go / npx） | 不管它用什么写 |

## 结构（两个文件）

```
plugin.json      # 声明 tier=L2 与 mcp.recipe
recipe.json      # 起哪些 server、怎么起
server.mjs       # 模板自带的示例 server（真能跑）
```

`recipe.json` 与 `~/.lynn/mcp.json` **完全同格式**——底层是同一个 `McpRegistry`，
两套格式只会让人困惑。

```json
{
  "servers": [
    { "id": "demo", "command": "node", "args": ["server.mjs"], "timeoutMs": 15000 }
  ]
}
```

## 试跑

```bash
# 1. 校验
node scripts/check-plugin-package.mjs plugins/_templates/mcp-l2

# 2. 单独试 server（手动喂一条 initialize）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node plugins/_templates/mcp-l2/server.mjs
```

## 写自己的 server 时三条纪律

| 纪律 | 为什么 |
|---|---|
| **日志走 stderr** | stdout 是协议通道；混进日志客户端就解析失败（最常见的错误） |
| 一行一条 JSON | 换行分隔，不能美化输出 |
| 通知（无 id）不用回 | 回了反而让客户端困惑 |

## 隔离边界（重要，与 L1 不同）

L2 进程**不在本应用的沙箱里**——它用别人的运行时。我们能保证与不能保证的：

| 能保证 | 不能保证 |
|---|---|
| 只给 PATH 等必需环境变量（不继承密钥） | 那个程序自己读什么文件 |
| cwd 钉在插件目录 | 它连什么网络 |
| 崩溃不拖垮内核、超时可强杀 | 它内部的行为 |

**所以装 L2 插件等于同意「运行这个程序」**——只在信任来源时安装。
