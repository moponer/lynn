# AGENTS.md · 给 coding agent 的入口

> 你（Codex / Claude Code / Cursor / 风铃自己 / 任何 agent）在这个仓库里工作前，先读这一页。
> 它只讲**必须知道的**，细节都指向具体文件。

## 1. 这是什么项目

**Lynn（风铃）**：本地优先的桌面 AI 个人助理（Electron + React + TypeScript）。
她是**指挥者不是执行者**：自己不改文件、不跑命令，通过招募「成员」来执行。
内核在 `src/main/`（约 33k 行），渲染层在 `src/renderer/`。

## 2. 三条硬约束（不可违反）

| 约束 | 含义 | 违反的后果 |
|---|---|---|
| **完全本地** | 提示词/技能/基准全是本地文件，**零网络依赖** | 断网就不可用 |
| **离线可用** | 断网时提示词编译、派单、验收全部可用 | 同上 |
| **质量不降** | 每轮工具结果正常追加（≥400 tokens），不做"盲操作" | 成员开始瞎猜 |

## 3. 你要写插件？只看这三处

| 你要做什么 | 读这个 |
|---|---|
| **了解插件包格式** | [`docs/plan/25-plugin-package-spec.md`](docs/plan/25-plugin-package-spec.md) |
| **复制一个能跑的起点** | `plugins/_templates/`（6 个模板，覆盖 L0 主题 / L0 语言包 / L1 工具 / U 界面 / L1 组合 / L2 MCP） |
| **校验你写的东西** | `node scripts/check-plugin-package.mjs <你的目录>` |

### 最短路径（三条命令）

```bash
cp -r plugins/_templates/tool-l1 my-plugin    # 1. 复制模板
# 改 plugin.json 的 id/name/version，改 index.ts
node scripts/check-plugin-package.mjs my-plugin   # 2. 校验（报错会告诉你具体改哪）
```

装：应用里导入该目录，或走 RPC `plugins.import`。

### 一个插件长什么样（唯一必填是 plugin.json）

```json
{
  "id": "lynn.demo.hello",
  "name": "示例",
  "version": "1.0.0",
  "apiVersion": 1,
  "tier": "L0",
  "engines": { "kernel": ">=0.0.1" },
  "contributes": { "langs": ["lang.json"] }
}
```

**四档由「有没有代码」决定，不由「有几种能力」决定**：

| 档 | 代码 | 能力 |
|---|---|---|
| L0 | 无 | 主题 / 语言包 / 形态 CSS / 技能 / 斜杠命令 |
| L1 | TS（隔离进程） | 注册工具 |
| L2 | 外挂进程（MCP） | MCP server 提供的工具 |
| U | HTML（iframe） | UI 卡槽 |

**一个插件可以同时有多种能力**（`tools` + `langs` + `style` + `slots` + `commands` + `skills`），
它们不是四种插件，是同一个 `contributes` 里的几个字段。

**八种能力现在都有加载器**（主题 / 形态 CSS / 语言包 / 工具 / UI 卡槽 / 内置视图 / 斜杠命令 / MCP），
且都**声明即生效**——写了不会没反应。具体哪些能用、哪些刻意不给，
看 [`docs/plan/26-plugin-coverage.md`](docs/plan/26-plugin-coverage.md)
——那里按「真能用 / 声明了没接 / 刻意不给」三档列清。

## 4. 改代码前必须跑什么

```bash
npm run typecheck        # 两个 tsconfig 都要过
npm test                 # 全量（约 3-5 分钟）
npm run lint             # oxlint --deny-warnings
npm run lint:design      # 零描边、四功能色、CSS 变量必须有定义
npm run lint:i18n        # JSX 里的中文必须走 t()
```

**这五条是 CI 会拦的**，本地不跑等于把返工推给别人。

## 5. 这个仓库的几个"反直觉"约定

读懂这几条能省你半天：

| 约定 | 为什么 |
|---|---|
| **`dist/` 是构建产物，不要手改** | `npm run build:main` 会覆盖 |
| **改提示词必须更新 golden 快照** | `npm run bench:golden:write`；否则 `tests/prompt-golden.test.mjs` 红 |
| **vendor 目录只读** | `prompts/vendor/` 有 sha256 清单；改它会被 `lint:prompts` 抓出来。改动只能进 `prompts/adapters/` |
| **工具面顺序不能随便变** | 顺序决定请求前缀；变了等于把缓存命中率打回原点（见 `docs/plan/03-cache-hit.md`） |
| **不要给插件 `system-prompt` 替换权** | 同上：前缀稳定性是命中率地基（见 `docs/plan/23-plugin-model-research.md`） |
| **删插件是移到 `plugins-trash/`** | 不是永久删除——装错的可能是用户自己写的 |
| **改插件是"更新"不是"覆盖"** | 更新会先归档旧版（`plugins/.versions/`），可一键回滚 |

## 6. 测试怎么组织

| 目录 | 内容 |
|---|---|
| `tests/*.test.mjs` | 主套件（node:test）。`npm test` 只跑 `tests/` |
| `tests/helpers/render-ssr.mjs` | 组件测试用 `react-dom/server`（**不是 RTL**，见下） |
| `bench/` | 基准任务与 fixtures（**不要**让它的 `*.test.js` 被主套件收集） |

**为什么不用 RTL**：`@testing-library/react` / `jsdom` 不在依赖里，且本机连不上 npm registry。
`react-dom/server` 能真实渲染组件成 HTML——只覆盖结构与内容，**不覆盖交互**。
要补交互测试得先解决依赖问题。

## 7. 已知缺口（别假装它们不存在）

**当前没有已知缺口。** 八种能力全部有加载器，且都"声明即生效"。

近期补上的三项：
- `update_plugin`（P12-1）：更新自动归档旧版，回滚用 `plugins.rollbackVersion`
- `contributes.skills`（P12-2）：技能改成按声明加载，不再是"填不填都一样"
- `commands` / `mcp`（P11-1/P11-2）：斜杠命令与 L2 MCP 都接上了加载器

## 8. 权威文档在哪

| 主题 | 文件 |
|---|---|
| 方案总览与批次 | `docs/plan/00-overview.md`、`20-roadmap.md` |
| **当前进度（先看这个）** | `docs/plan/PROGRESS.md` |
| 插件化评估 | `docs/plan/22-pluginization.md` |
| 参照物研究（Codex / DSH） | `docs/plan/23-plugin-model-research.md` |
| 自举与自修改边界 | `docs/plan/24-self-hosting.md` |
| **插件包规范** | `docs/plan/25-plugin-package-spec.md` |
| **插件覆盖范围（能做什么）** | `docs/plan/26-plugin-coverage.md` |

**动手前先读 `PROGRESS.md`**：它记着哪项做完了、哪项标了"待生产复测"、
以及哪些坑已经踩过。跳过它会重复别人的错误。
