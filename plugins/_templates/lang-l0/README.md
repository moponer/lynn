# 示例语言包（L0 模板）

演示**不改代码就能改文案**。

## 关键点

- 一个插件可以带**多个语言包**（这里 zh + en 各一份）；
- `lang` 字段必须是 `"zh"` 或 `"en"`；
- 缺键时回退内置中文（不会显示成 `demo.greeting` 这种键名）；
- 单条文案上限 500 字符。

## 校验

```bash
node scripts/check-plugin-package.mjs plugins/_templates/lang-l0
```
