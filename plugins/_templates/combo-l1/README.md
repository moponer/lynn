# 组合插件（L1 模板）：一个插件，四种能力

这个模板回答的是「**不同能力怎么统一**」：

> 它们不是四种插件，而是**同一个 `plugin.json` 里的四个 `contributes` 字段**。

## 一个 manifest，三种能力

```json
"contributes": {
  "tools":    ["echo"],           // 工具（要 entry）
  "langs":    ["lang-zh.json"],   // 语言包
  "style":    "style.css"         // 形态层
}
```

> **注意**：最初这个模板还演示了 `commands`（斜杠命令），后来发现
> **`contributes.commands` 没有任何加载器**（全仓 0 处引用）——
> 写了不会生效，反而误导人。已从模板移除，详见 `docs/plan/26-plugin-coverage.md` 第 3 节。

校验器是同一个 `checkManifest()`，安装器是同一条 `importPluginPackage()`。

## 为什么组合有意义

一个"周报助手"可能同时需要：

| 需要 | 对应能力 |
|---|---|
| 算数据 | `tools` |
| 它自己的几条文案 | `langs` |
| 一点专属样式 | `style` |
| 一个触发入口 | ⚠ `commands` 字段存在但**没有加载器**（写了不生效） |

拆成四个插件会让用户**装四次、启四次**，还要自己对齐版本。

## 档位怎么定

这个模板是 **L1**，因为它有代码（`index.ts`）。
如果去掉 `tools` 与 `entry`，只留 `langs` + `style`，它就是 **L0**——
**档位由"有没有代码"决定，不由"有几种能力"决定**。

## 校验

```bash
node scripts/check-plugin-package.mjs plugins/_templates/combo-l1
```
