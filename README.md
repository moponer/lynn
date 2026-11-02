# 风铃 Lynn

**每个人都该有一只自己的风铃。** *A Lynn of your own.*

本地优先、插件化的桌面 AI 个人助理——**她是指挥者，不是执行者**：她组队、派单、盯进度、审查证据、向你汇报。基于 [earendil-works/pi](https://github.com/earendil-works/pi) 生态，薄壳 + 三档插件 + MCP 能力外挂。

> 当前状态：**M0 进行中**。已有：类型化 IPC 单一契约、Electron 薄壳、管理型 8 件套（真实执行、落盘、审计、硬约束）、成员档案 v1、插件 manifest v1 校验器 + 版本闸门、Pi 配置根重定向与无遥测开关、**权威工单实体（七态 / version / parent / evidence）+ 任务卷宗 + 三层存储（压缩与归档）**、**UI 插件卡槽 + 从磁盘加载 U 插件（iframe 沙箱）**、**形象舞台（三视图 / 状态机 / 心声）**、**动效层与待机模式（GPU 红线已实测）**、**设计约束 CI（零描边 / 四功能色）**、91 条 `node --test` 用例、CI（typecheck + lint:design + test）。
> 尚未完成：Pi 运行时的 RPC 独立进程接入（当前为进程内 SDK 过渡路径）、插件三档加载器、权限门禁、七态任务实体。
> 完整任务与验收口径见 [`../docs/开发任务清单.md`](../docs/开发任务清单.md)。

## 运行

```bash
npm install
npm run build   # typecheck + renderer(vite) + main(tsc)
npm test        # build:main + node --test（113 条）
npm run lint:design   # 零描边 / 四功能色 / 无装饰色（CI 会跑）
npm start       # electron .
```

首次启动点右上角 ⚙：填 Base URL / API Key / 模型（Key 用系统 safeStorage 加密存本机，可先「测试连接」再保存）。

## 结构

```
src/
├── shared/contract.ts    # 类型化 IPC 契约（RPC + 事件流，唯一契约）
├── main/
│   ├── main.ts           # Electron 薄壳：窗口 + IPC 转发 + safeStorage（无 Agent 逻辑）
│   ├── preload.ts        # contextBridge：window.lynn.rpc / onEvent
│   ├── kernel.ts         # 内核：流式对话循环 + 管理工具 8 件套真实执行 + 指挥板推导
│   ├── llm.ts            # OpenAI 兼容 SSE 客户端（工具调用增量聚合）
│   ├── settings.ts       # ~/.lynn/settings.json（Key 加密）
│   ├── pi-home.ts        # Pi 配置根重定向 + 无遥测开关（PI_CODING_AGENT_DIR 等）
│   ├── task-store.ts     # 工单实体：七态 / version 乐观并发 / parent 防环 / evidence 准入
│   ├── task-case.ts      # 任务卷宗：timeline.jsonl 只追加 / artifacts 永久 / summary 滚动
│   ├── context-store.ts  # 温层：摘要 + 最近 N 轮；超阈值压缩，冷层原文不动；14 天归档
│   ├── team-store.ts     # 成员书面岗位 Markdown + ~/.lynn/team 布局
│   ├── management-tools.ts # 8 件套硬约束（收窄/打回上限/证据原则/审计）
│   └── plugin-manifest.ts  # 插件 manifest v1 校验器 + 版本闸门
├── renderer/             # 值台：desk/(Desk.tsx + model.ts) + styles/dispatch.css（设计稿 Token）
├── ../docs/design-previews/2026-11-01-lynn-dispatch-desk/  # 设计稿正本（lynn.css 已复制进 renderer）
tests/                    # node --test：成员档案 / manifest / 8 件套 / 工具面 / Pi 重定向
```

## 设计基线

- **以《风铃-界面设计规范.md》v1.0 为准**（规范与计划书冲突时以规范为准）：值台 / 制图室、三栏不对等（台账 258 / 图纸 flex / 编制表 384）、**三种声音三种语汇**、**零卡片描边**、四功能色（`--blue` 结构 / `--seal` 等你拍板 / `--red` 打回 / `--brass` 预算）。
- **值台 / 审查台 / 造铃向导 / 我的风铃 / 桌宠已落地**（`src/renderer/desk/`）：三栏骨架、title block、证据链、印章区、打回三要素、四步向导、三套主题 × 亮暗（夜航 / 纸墨 / 青瓦）、`.lynnpack` 导出导入（只含配置）、透明置顶桌宠小窗（单击唤回）。
- 权限四模式（plan/ask/auto/full）已进顶栏，但**尚未接 `tool_call` 门禁**（M1-10）。
- 尚未做：VRM 驱动（three-vrm，与形象统一到 WebGL 渲染器）、温层 SQLite/FTS、L1（jiti）加载器与冲突检测/权限对账。

## 隔离试装（装之前先跑一次）

```bash
# L2 插件：按 recipe 起真 MCP server，做 initialize → tools/list → shutdown，超时或崩溃即判失败
# 内部实现：src/main/plugin-probe.ts（一次性子进程 + 进程树击杀，Windows 用 taskkill /T /F）
```

L0 直接判通过（纯数据），L1 如实返回「需要 jiti，当前未接」——**不假装支持**。测试用真子进程验证：正常握手、非零退出、卡死超时三种路径。

## 皮肤包（社区投稿）

规范见 [`../docs/皮肤包规范.md`](../docs/皮肤包规范.md)：纯声明式 —— 只声明内置动效器 + 16 个白名单 Token，带脚本/外联/新 Token 一律拒收。校验器 `src/shared/skin.ts`，测试 `tests/skin.test.mjs`。

## 性能验收

```bash
npm run perf:standby      # 进待机跑 60s，按 5s 窗口记帧率 → perf/standby-fps.json
# 另开一个终端采样同一进程的 GPU / CPU：
pwsh -File scripts/perf-sampler.ps1 -Seconds 50 -IntervalSec 5   # → perf/gpu.json
```

实测（2026-11-01，本机）：待机 60s 平均 **4.8fps**（目标 5fps，间隔 200ms），GPU 引擎利用率 **0%**，CPU **0.17%**。GPU 数字按进程树加总，目标机型建议复测一次。

## 装一个 U 插件

```bash
mkdir -p ~/.lynn/plugins
cp -r examples/ui-plugins/lynn.demo.hello ~/.lynn/plugins/
# 重启后顶栏 status.bar 会出现「磁盘插件 · 已加载」
```

契约（`plugin.json`）：`tier: "U"`、`contributes.slots` 必须来自 8 个白名单卡槽、`entry` 必须是插件目录内的 `.html`（≤512KB）。第三方插件一律跑在 `sandbox="allow-scripts"` 的 iframe 里，只能 postMessage，摸不到宿主 DOM。

## 装一个主题插件（L0）

```bash
cp -r examples/plugins/lynn.theme.dusk ~/.lynn/plugins/
# 重启 → 「我的风铃」的「皮」里出现「主题插件 · L0」按钮，点一下即生效
```

L0 是纯数据：`plugin.json` 的 `contributes.theme` 指向一个 `theme.json`，里面只能覆盖 16 个白名单 Token（暗/亮两组），带脚本或新 Token 会被 `PluginHost` 直接拒收。启停状态存在 `~/.lynn/plugins/_state.json`。

## 文档

| 文档 | 管什么 |
|---|---|
| [`../docs/立项计划书-全方位个人助理.md`](../docs/立项计划书-全方位个人助理.md) v0.5.0 | 产品形态、架构、插件体系、指挥与团队运行时、里程碑、风险 |
| [`../docs/风铃-界面设计规范.md`](../docs/风铃-界面设计规范.md) v1.0 | 界面结构、视觉语言、数据契约、实现路线 |
| [`../docs/开发任务清单.md`](../docs/开发任务清单.md) v1 | 未完成任务（按 M0–M4 + 横切编排）、决策、文档缺口 |

## 下一步（M0 剩余）

1. **实验 6：纯提示词版指挥环**（计划书 §7，最优先）——量 token 成本、假验收率、打回轮数。
2. Pi 接入改为 RPC + 扩展宿主、独立进程（计划书 §4.1）。
3. L1（进程内 TS）/ L2（MCP）加载器 + `/reload` 排队语义（L0 已落）。
4. VRM 驱动（需 `three-vrm` 依赖 + 授权明确的开源模型）。
5. 温层 SQLite/FTS（随 M2-04 知识库）。

## 界面走查

```bash
npm run build
npm run shot          # 值台 → shots/desk.png
npm run shot -- review    # 审查台 → shots/review.png
npm run shot -- wizard    # 造铃向导 → shots/wizard.png
npm run shot -- x paper:light     # 纸墨亮色 → shots/desk.png（覆盖）
```

第 4 个参数是 `theme:mode`（`night|paper|celadon` × `dark|light`）。`scripts/preview-shot.cjs` 用一份假桥（`preview-preload.cjs`）喂空数据快照，页面自动落到设计稿示例图纸，便于逐像素对比。
