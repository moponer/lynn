# prompts/ · 提示词资产

> 一次性引入的上游资产，**冻结**。改内容只能改 `adapters/`（06 章 §1/§4）。

```
prompts/
  vendor/                上游正文，只读；手改会被 lint:prompts 按 sha256 抓出来
    sources.json         本机来源路径（只有 sync 用得到）
    codex/               LICENSE · UPSTREAM.json · roles/ · protocol/
    superpowers/         LICENSE · UPSTREAM.json · roles/ · skills/
    zcode/               LICENSE · UPSTREAM.json · roles/
  adapters/              我们唯一可以改的一层：工具映射、回报契约、领域裁剪
```

## 常用命令

```bash
npm run lint:prompts      # 校验 vendor 未被手改 + 全部角色能离线编译
npm run prompts:sync      # 重新从本机来源拷贝（人工决策，不是同步）
npm run prompts:compile   # 列出每个角色的编译体量
node scripts/prompts/compile.mjs --role implementer   # 看某个角色的成品
```

## 两条硬规则

**1. vendor 只读。** `UPSTREAM.json` 记着每个文件的 sha256；手改一个字节，
`npm run lint:prompts` 就会指出是哪个文件、清单与实际各是什么。确需更新上游内容只有一条路：
改 `sources.json` → 跑 `prompts:sync` → 同步更新受影响的 adapter 头部 `sha` → 在
`THIRD_PARTY_NOTICES.md` 与 `PROGRESS.md` 各写一行。

**2. adapter 钉住上游版本。** 每个 adapter 头部有 `sha: <前 8 位>`。编译时会比对，
不符就报错——否则「任一角色能追到 vendor + adapter」只是文档里的一句话。

## 编译做了什么

`scripts/prompts/compile.mjs` 是纯函数式的本地拼装，断网结果完全一样：

1. 读 adapter 的 frontmatter（`role` / `from` / `sha` / `toolMap`）；
2. 校验 `from` 指向的 vendor 文件 sha256 与 `sha` 一致；
3. 读 vendor 正文，**剥掉 YAML frontmatter**（zcode 的 agent 文件带角色/模型/工具声明，不该发给模型）；
4. 按 `toolMap` 做工具名替换（`Read→read_file`、`Bash→run_command`…）；
5. 拼上身份头与 adapter 正文（我们的差异、回报契约、自检）。

最后跑一条硬不变量：**编译结果里不许残留任何上游工具名**。漏一个映射，成员就会去调一个
不存在的工具，然后空转到打回上限——这是 11-16 复盘里那类失败，不是假想。

## 暂未引入的东西（有意的）

| 没引入 | 原因 |
|---|---|
| `gpt_5_*_prompt.md`（Codex 整段系统提示词） | 我们的编译器自己组装；直接用别人的整段会覆盖人设与工具事实 |
| superpowers 技能里的 `references/` 与 `scripts/` | 服务上游自己的运行环境（Codex CLI / Copilot），我们没有对应实现，收进来是死文件 |
| zcode 四个插件各自的 `visual-judge.md` 副本 | 四份 sha256 完全一致，合并为一份；差异已记在 `UPSTREAM.json` |

## 许可与来源

每个 vendor 目录内保留上游 `LICENSE` 原件；来源、许可、引入时间与逐文件哈希见各
`UPSTREAM.json`，汇总说明见仓库根 `THIRD_PARTY_NOTICES.md`。
adapter 文件头注明 `from` 与 `sha`，满足 06 章 §6 的修改标注要求。