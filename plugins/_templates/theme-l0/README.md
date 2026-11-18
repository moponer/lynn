# 示例主题（L0 模板）

这是一个**最小可用的 L0 主题插件**，用来当模板复制。

## 怎么用

1. 把整个目录复制到别处，改成你自己的名字；
2. 改 `plugin.json` 里的 `id` / `name` / `version`（`id` 必须是反向域名格式，2–4 段小写）；
3. 改 `theme.json` 里的配色；
4. 校验：`node scripts/check-plugin-package.mjs <你的目录>`；
5. 装：应用里导入这个目录，或走 RPC `plugins.import`。

## 这个模板演示了什么

| 能力 | 在哪 |
|---|---|
| 配色（深/浅两套） | `theme.json` 的 `dark` / `light` |
| 形态层 CSS | `style.css`（可选，禁 `@import`） |

## 注意

- L0 **没有代码**，改不了行为边界——这是它能被风铃自启用的原因；
- `theme.json` 里的五个颜色键是**必需的**：`desk` / `sheet` / `blue` / `seal` / `brass`。
  缺了界面会有地方取不到色。
