<div align="center">
<h1>风铃 Lynn</h1>
<p><strong>每个人都该有一只自己的风铃</strong><br><em>A Lynn of your own.</em></p>
<p><img src="./docs/badges/verify.svg" alt="verify: passing"> <img src="./docs/badges/tests.svg" alt="tests: 700+"> <img src="./docs/badges/license.svg" alt="license: MIT"> <img src="./docs/badges/stack.svg" alt="stack: Electron + TS"> <img src="./docs/badges/platform.svg" alt="platform: Windows"></p>
</div>

本地优先的桌面 AI **指挥助理**：她不亲自干活，而是组队、派单、盯进度、核对证据、向你汇报。Electron + TypeScript，Windows 优先；数据全部留在本机 `~/.lynn/`。

![值台主界面](./docs/screenshots/desk.png)

## 一眼看懂

| | |
|---|---|
| **她是指挥者** | 风铃只派单与验收；成员在各自工作区执行，产出落盘才收回报 |
| **卷宗** | 每张工单有 `timeline` / `artifacts` / `evidence`；交付物永久保留，过程证据只登记 |
| **审批** | 删除、改名等危险操作弹卡等你点头，可按「族」长期放行 |
| **双运行路径** | Pi RPC 独立进程（默认）与直连 SSE（降级）；切换模型不必换会话 |
| **本地优先** | API Key 由系统 `safeStorage` 加密；成员命令环境会剔除凭据变量 |

## 多智能体架构

风铃手里**没有执行工具**，只有一份编制和 19 件管理动作；真正动手的是编制里的成员，各自在自己的工作区跑，互不通信，一切经她转发。

```
你
│
├─ 风铃（指挥者 · 跑在 Pi agent 会话里）
│    工具面 19 件，全是管理动作：
│    create_team / create_member / assign_task / check_progress / check_roster
│    nudge_member / stop_task / read_artifact / review_result / accept_or_reject
│    report_to_user / set_group_notice / ask_user / dissolve_team / ship_plugin
│    save_memory / read_memory / forget_memory / create_plugin_draft
│    ↑ 没有 bash、write、edit、browser、office —— 一件都没有
│
├─ 团队编制（与群绑定：一个群 = 一件事 = 一份编制）
│    ├─ 阿计 · 数据整理    read_file write_file list_dir run_command
│    ├─ 阿元 · 代码实现    read_file write_file run_command
│    └─ 老陈 · 验收员      read_file list_dir        ← acceptor：只验收，不执行
│
└─ 每个成员是一个独立的模型循环（不是子进程、不是第二套 agent 框架）
     任务工作区 + 只读根授权 + 证据回报
```

三条边界**写死在代码里**，不靠提示词自律：

| 边界 | 实现 |
|---|---|
| 工具面隔离 | 她 19 件管理工具；成员 16 件执行工具（`MEMBER_EXEC_TOOLS`）。成员白名单里出现管理工具 → 招募时就抛错；她若调用 `bash`/`write` → 未知工具，不会执行 |
| 工作区钉扎 | 成员的文件读写钉死在任务工作区，路径逃逸在工具层直接拒绝；要读工作区外的材料必须走 `readRoots` 申请制，契约卡上你点「开始」才落权 |
| 单层指挥 | 成员不能招募、不能验收、没有 `ask_user`；成员之间不通信，一切经她转发 |

编制默认 6 人上限（超过要写理由），成员档案记着角色、工具白名单、轮次上限、何时必须停手升级、岗位工作方式。**群 A 的成员在跑时群 B 照样能派单**，两条线并行。

## 一次派单的完整链路

```
你：帮我把这份销售数据清洗完，出一份带图的周报
 │
 ├─① 接单三问：目标 / 完成标准 / 材料在哪 —— 答不上就先问你，不猜、不盘查你的目录
 ├─② 简报四段闸（纯函数 validateBrief，代码层）
 │     目标 · 完成标准 · 材料与位置 · 限制
 │     少于 30 字或缺任一段 → 当场退回，不建单、不出契约卡
 ├─③ 契约卡：谁做 / 做什么 / 验收点 / 截止 / 禁区 / 取舍口径 → 你点「开始」
 ├─④ 派单即开工：dispatchMember 后台跑，她继续处理别的消息（不阻塞当轮对话）
 ├─⑤ 成员执行：核对材料 → 写产物 → submit_report + checks[] 证据
 ├─⑥ 验收下沉：编里有验收员就先按完成标准逐条核；没有才由她亲自验
 ├─⑦ 硬闸：accept 之前必须 read_artifact 读产物正文
 │     只看文件在不在，会把空骨架稿当成成品收下
 ├─⑧ 打回：写清哪里不合格 / 期望是什么 / 时限；上限 3 轮，之后升级成「怎么办」问你
 └─⑨ 归档：产物进 tasks/<id>/artifacts 卷宗永久保留，过程证据只登记不搬运
```

档位只影响**哪一步需要你点头**：

| 权限档 | 契约卡行为 |
|---|---|
| 计划 `plan` / 询问 `ask` | 必须点「开始」才开工 |
| 自动 `auto` / 全权 `full` | 只读授权直接生效，契约卡只作告知 |

![审批卡：这类以后都允许](./docs/screenshots/approval.png)

## 基于 Pi agent 开发

风铃的会话跑在 **Pi**（`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent`）上，不是自研 agent loop。

| 层 | 归谁 |
|---|---|
| 会话、上下文压缩、重试、错误事件、工具调度 | **Pi 基座**，原样不动 |
| 模型与凭据 | Pi 的 `models.json` + 环境变量插值（`$LYNN_MODEL_API_KEY`），明文 Key 只经子进程 env 传递 |
| 进程隔离 | Pi 官方 `dist/bundle/rpc-entry.js` 独立子进程（`--mode rpc`），崩了不带走界面 |
| 传输胶水 | Electron 侧只做 NDJSON 帧、id 配对、双档超时（45s / 30min）、busy 看门狗、进程树回收 |
| 工具实现、权限门禁、审计、UI | **留在主进程**：扩展把工具调用经官方 `extension_ui_request/response` 交回壳里执行 |
| 风铃特有逻辑 | 唯一合法落点 = 官方扩展 `agent/extensions/lynn-bridge.mjs`（注册壳下发的工具 + 每轮注入 persona） |

红线是**基座完整不变，新功能插件式接入**：`node_modules/@earendil-works/**` 一行没改，升级 Pi 不需要动我们的代码。

降级路径：Pi 子进程起不来时自动退回直连 SSE（`llm.streamChat`），功能子集但会如实说明，不静默失败。

成员侧**不用 Pi**：成员是同一个 `streamChat` 上的轻量工具循环（`src/main/member-runner.ts`），因为它不需要会话恢复、压缩与跨轮记忆，只需要「核对材料 → 干活 → 交回报」这一件事。

## 快速开始

要求 Node 22+（建议 22.12 以上）。

```bash
npm ci
npm run build   # typecheck + renderer(vite) + main(tsc)
npm start       # electron .
```

首次启动点右上角 ⚙ 填 **Base URL / API Key / 模型**，可先「测试连接」再保存。

> **桌宠暂时停用**：57 张姿态图共 20 MB（重画一次就翻倍），素材已移出仓库与打包，渲染与设置入口一并注释（`pet-assets.ts` 改为空串占位，`?pet=1` 返回空）。构建**不再需要**素材。恢复步骤见 [`docs/pet-assets.md`](./docs/pet-assets.md)。
>
> 想直接看界面而不接模型：`npm run build:renderer && npm run shot -- shots/desk.png`（走查用假桥数据）。

## 验证链

```bash
npm run verify          # typecheck → oxlint → lint:design → 700+ 条 node --test
npm run lint            # oxlint，基线 0 warning / 0 error
npm run build:main      # 主进程 CJS 产物
npm run build:renderer  # vite 产物
```

三个**真实**对照探针会调用已配置的模型（少量 token，结果写入被 gitignore 的 `shots/*.json`）：

| 命令 | 验证什么 |
|---|---|
| `npm run probe:usage` | 7 个已配置模型的最小探针 + 前缀 A/B 对照，看各端点回报哪些缓存字段 |
| `npm run probe:pi` | 真 `Kernel` + 真 Pi 子进程跑 6 轮，验证「改公告不断前缀、改 system 内容立刻断」 |
| `npm run probe:ui` | 真 Electron 窗口里点输入框发两轮消息，验证卡片、用量落盘与缓存徽章 |

实测结论见 [`docs/token-cache-audit-lynn.md`](./docs/token-cache-audit-lynn.md)：Pi 路径下改群公告命中率维持 94.7–98.1%，改 system 内容掉到 0–3.4%。

## 打包

```bash
npm run dist   # electron-builder --win → release/Lynn-0.0.1-setup.exe（NSIS）
```

本机两个注意点：electron-builder 会先清空旧的 `win-unpacked`，文件数超过本机 safe-delete 阈值时要输出到**全新目录**；GitHub release 下载不稳定时可用 `electronDist: node_modules/electron/dist` 直接复制本地 Electron。安装包目前**未做代码签名**。

## 结构（2026-11-15）

```
src/
├── shared/
│   ├── contract.ts        # 类型化 IPC 契约（RPC + 事件流，唯一契约）
│   ├── i18n-strings.ts    # 中英字典；派生的 I18nKey 让 t() 拼错就编译报错
│   └── magic-words.ts     # ultrathink / chillax / orchestrate，只影响当轮
├── main/
│   ├── main.ts            # Electron 薄壳：窗口 / IPC / safeStorage / 托盘
│   ├── kernel.ts          # 内核编排（8689 行；热点 RPC 已拆成命名方法）
│   ├── pi-rpc-host.ts     # Pi 官方 RPC 胶水：NDJSON 帧 / id 配对 / 双档超时 / 看门狗
│   ├── rpc/               # 数据面 RPC：settings-rpc.ts / thread-rpc.ts
│   ├── team-store.ts      # 编制：成员档案、工具白名单、模板导入
│   ├── task-store.ts      # 工单卷宗：七态、brief/验收口径冻结、artifacts / evidence
│   ├── management-tools.ts# 她的 19 件管理工具（执行类工具不在这里）
│   ├── member-runner.ts   # 成员执行循环 + 工具白名单 + 回报校验（含 checks）
│   ├── toolkit.ts         # 路径钉扎 / unified diff / 分页读 / grep / 命令执行
│   ├── advisor.ts         # 独立模型审阅：三档 severity + 空话过滤 + 去重预算
│   ├── cmd-env.ts         # 命令环境白名单 + 非交互加固 + PATH 前置 POSIX 工具
│   ├── cmd-output.ts      # execa 原始 Buffer → GBK 兜底 → head+tail 保 stderr
│   ├── pdf-text.ts        # pdfjs-dist 提文本（扫描件如实说提不出来）
│   ├── budget.ts / cleanup.ts / memory.ts / settings.ts / …
├── renderer/desk/         # 值台：Desk.tsx(397 行) + 9 个面板文件
│   ├── Ledger.tsx  Sheet.tsx  Roster.tsx  Composer.tsx
│   ├── Seals.tsx   Menus.tsx  Review.tsx  Palette.tsx  TopRail.tsx
│   └── model.ts / use-tick.ts
├── renderer/boot/
│   └── BootScreen.tsx     # 启动页：字距收拢 + 真实快照进度条
agent/                     # Pi 侧接入层（基座在 node_modules，这里只有我们的扩展）
├── extensions/lynn-bridge.mjs  # 官方扩展：把壳下发的工具注册成 Pi 工具 + 每轮注入 persona
└── l1-worker.mjs               # L1 插件执行 worker（jiti 现场编译 TS）
scripts/
│   ├── shots/*.cjs        # 44 个走查模式（注册表，主文件 297 行）
│   ├── make-icon.py       # 图标生成（几何切角 L，纯 Pillow）
│   ├── shot-boot.cjs      # 启动页走查截图
│   └── live-*probe*.cjs   # 真模型 / 真 Pi / 真 UI 对照探针
tests/                     # 700+ 条 node --test（含整链路模拟任务）
```

拆分划线原则：**按数据面 / 编排面拆，不按方法数量拆**。`task.*` 依赖 22 个成员（含可变状态集合），留在 kernel 里只做薄转发，避免状态所有权分裂。

## 这一轮加固了什么

| 面 | 落地 |
|---|---|
| 正确性 | 命令环境剔密钥、RPC 契约 ↔ 实现双向 parity 测试、i18n key 编译期校验、`readUsage(0)` 等边界修复 |
| 成本 | 缓存分层（易变事实移出 system prompt）、启动两段化、oxlint 清零 |
| 工具面 | `edit_file` 支持 unified diff、`read_file` 按行分页、`grep` include/大小写/上限、PDF 读取、`list_dir` 带大小时间 |
| 执行面 | `execa` + GBK 解码 + stderr 尾部保留 + 超时强杀 + 「停」真杀进程、`usage.jsonl` 轮转 |
| 能力 | 魔法词、顾问第二模型 + 模型角色表、成员回报 `checks[]`、骨架稿拦截、项目级记忆、审批族长期放行 |
| 可观测 | Pi 路径按次台账、`cacheFieldsReported`、成员台账、`cacheBreakReason`，三个真模型探针 |
| 结构 | `Desk.tsx` ~5030 → **401** 行、`kernel.ts` 抽出 RPC 子模块、`preview-shot.cjs` 1205 → **297** 行 |
| 品牌 | 图标配色回到项目 token、Archivo 字标、托盘/窗口/安装包/顶栏/favicon 同源、启动页 C 方案落地 |

![设置页：顾问审阅开关](./docs/screenshots/settings.png)

## 设计基线

- 三栏不对等、**零卡片描边**、四功能色（`--blue` 结构 / `--seal` 等你拍板 / `--red` 打回 / `--brass` 预算）；`npm run lint:design` 把关。
- 中英 i18n 全量 key 化，调用点由 `I18nKey` 编译期约束。
- 命令执行面不自己造轮子：`diff`(BSD-3) / `execa`(MIT) / `iconv-lite`(MIT) / `pdfjs-dist`(Apache-2.0) / `oxlint`(dev, MIT)。
- CI：`.github/workflows/ci.yml` → `windows-latest` + Node 22 + `npm ci && npm run verify`。

## 文档

| 文档 | 管什么 |
|---|---|
| [`docs/site/zh/`](./docs/site/zh/) · [`en/`](./docs/site/en/) | 用户与插件开发者文档站：快速开始 / 插件指南 / 索引 / 隐私 / 发布签名 |
| [`docs/token-cache-audit-lynn.md`](./docs/token-cache-audit-lynn.md) | 用量与缓存实测报告（含真 Pi、真 UI 对照与仍存缺口） |
| [`docs/notes/`](./docs/notes/) | 仍有效的架构决策记录与历史评测报告 |
| [`docs/archive/`](./docs/archive/) | 已落地 / 过期的历史提案（不再作为现状依据） |
| [`PLUGIN-CONTRACT.md`](./PLUGIN-CONTRACT.md) | UI 插件契约 v1（卡槽语义 + iframe 沙箱） |
| [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) | 第三方声明（`node scripts/gen-notices.mjs` 再生） |

## 数据与隐私

- 数据根 `~/.lynn/`（可用 `LYNN_HOME` 覆盖）：设置、会话、工单卷宗、团队、插件、日志。
- API Key 由系统 `safeStorage` 加密；成员命令环境剔除变量名含 `KEY/TOKEN/SECRET/PASS…` 的值。
- 卸载默认**不删数据**（`deleteAppDataOnUninstall: false`）；交接机器前请手动删除 `~/.lynn/settings.json`。
- 安装包目前**未做 Windows 代码签名**，详见 [`docs/site/zh/release.md`](./docs/site/zh/release.md)。

## 已知边界

- 命令侧路径校验是启发式，挡不住变量拼接与脚本内读写，**不是 OS 级沙箱**。
- 消息平台只发不收（长连接未接）。
- `cost` 恒 0（未接 provider 定价）、无响应缓存，重复问同一句仍全额重算。
- Windows 代码签名未接入；macOS `icns` 图标未生成。

## 许可

MIT · [`LICENSE`](./LICENSE)
