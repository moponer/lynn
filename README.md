# 风铃 Lynn

**每个人都该有一只自己的风铃。** *A Lynn of your own.*

本地优先、插件化的桌面 AI 个人助理——**她是指挥者，不是执行者**：她组队、派单、盯进度、审查证据、向你汇报。基于 [earendil-works/pi](https://github.com/earendil-works/pi) 生态，薄壳 + 三档插件 + MCP 能力外挂。

> 当前状态：**M4 发布准备**（M0–M3 主体完成）。已有：Pi RPC 独立进程 + 薄壳、管理工具 10 件套（真实执行、落盘、审计、硬约束）、七态工单实体 + 卷宗 + 证据链、三档插件加载器（L0/L1/L2）+ U 档 iframe 沙箱 + 准入流水线 + 安全模式/回滚/指纹、**插件工坊（规格→草稿区→准入→分档启用）**、六大执行域（日历/cron/知识库/office/浏览器/消息平台合规路径）、技能体系（allowed-tools 强制）、成本软上限、多会话/撤销/托盘/更新器、**中英 i18n（语言包即 L0 插件）**、360 条 `node --test` 用例、CI（typecheck + lint:design + test）。
> 尚未完成：Windows 代码签名（无证书，如实注明，见[发布说明](./docs/site/zh/release.md)）、消息平台收消息（长连接）、VRM 驱动（暂缓）。
> 完整任务与验收口径见 [`../docs/开发任务清单.md`](../docs/开发任务清单.md)。**用户文档**：[快速开始](./docs/site/zh/quickstart.md) · [插件开发指南](./docs/site/zh/plugin-guide.md) · [插件索引](./docs/site/zh/plugin-index.md) · [隐私说明](./docs/site/zh/privacy.md) · English docs in `docs/site/en/`。

## 运行

```bash
npm install
npm run build   # typecheck + renderer(vite) + main(tsc)
npm test        # build:main + node --test（360 条）
npm run lint:design   # 零描边 / 四功能色 / 无装饰色（CI 会跑）
npm start       # electron .
```

首次启动点右上角 ⚙：填 Base URL / API Key / 模型（Key 用系统 safeStorage 加密存本机，可先「测试连接」再保存）。

## 微信式截图（全局快捷键）

按 `Alt+Shift+S`（或托盘「区域截图」、输入框下方「截图」按钮）→ 冻结光标所在显示器，进入选区窗：

- **自动识别窗口**：鼠标停在哪就高亮哪个窗口，单击截整个窗口；也可以拖动自由框选。
- **选区可调整**：拖动内部整体移动，八个控制点缩放；尺寸实时显示；放大镜跟随光标取色。
- **标注**：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克（从原图取样，撤销可完全还原）/ 文字 / 序号，四色三档粗细，`Ctrl+Z` 撤销。
- **完成动作**：`Enter` / 双击 / 工具栏「完成」= 进输入框**本轮随附**并复制到剪贴板；「复制」只复制；「保存」另存为 PNG；`Esc` / 右键 / 「取消」退出。随附条里发送前可见、可逐片移除，不自动发送。

引擎：[`node-screenshots`](https://github.com/nashaofu/node-screenshots)（Rust XCap + N-API，Apache-2.0，各平台预编译二进制）。Windows 走 DXGI 直取帧缓冲，本机实测 1920×1080 全屏捕获 87ms；`Window.all()` 提供窗口边界；比 `desktopCapturer` 快且不需要 macOS 屏幕录制授权。标注在选区窗 Canvas 上合成，主进程会核对 PNG 尺寸与选区一致后才复制 / 落盘，不引入第二个图像依赖。

Windows 上无边框窗口盖不住任务栏，所以冻结帧会先裁到 `workArea`（任务栏那几十像素不在选区窗里），视口尺寸由主进程下发，避免 Canvas 被压缩后选区与导出图差几个像素。

快捷键可在「我的风铃 → 外观」改；被占用或原生二进制缺失时如实显示「没注册上 / 引擎不可用」，不假装成功。实现：`src/shared/capture-geometry.ts`（共享几何）、`src/main/capture-host.ts`（冻结帧 / 窗口枚举 / 剪贴板与落盘）、`src/renderer/capture/`（Canvas 标注与交互）。原生二进制已列入 `electron-builder.yml` 白名单（`asar:false`）。

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
| `docs/site/zh/` · `docs/site/en/` | **用户与插件开发者文档站**：快速开始 / 插件指南 / 插件索引 / 隐私 / 发布签名 |
| [`PLUGIN-CONTRACT.md`](./PLUGIN-CONTRACT.md) | UI 插件契约 v1（冻结承诺 + 卡槽语义 + 沙箱） |
| [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) | 第三方声明（许可证 + 依赖清单，`node scripts/gen-notices.mjs` 再生） |
| [`LICENSE`](./LICENSE) | MIT |
| [`../docs/立项计划书-全方位个人助理.md`](../docs/立项计划书-全方位个人助理.md) v0.5.0 | 产品形态、架构、插件体系、指挥与团队运行时、里程碑、风险 |
| [`../docs/风铃-界面设计规范.md`](../docs/风铃-界面设计规范.md) v1.0 | 界面结构、视觉语言、数据契约、实现路线 |
| [`../docs/开发任务清单.md`](../docs/开发任务清单.md) v1 | 任务与验收口径（按 M0–M4 + 横切编排） |

## 卸载与数据残留

- 默认**卸载不删数据**（NSIS `deleteAppDataOnUninstall: false`，刻意的）：任务卷宗、团队档案、会话历史都在 `~/.lynn/` 里，重装后原样可用。
- 里面有凭据（`~/.lynn/settings.json` 的 API Key，safeStorage 可用时为加密存储）。把机器交给他人前，请手动删除 `~/.lynn/` 或至少 `~/.lynn/settings.json`。
- `electron-builder.yml` 当前未配置代码签名——更新源必须 HTTPS（`updater.ts` 强制），安装包完整性靠传输信道与发布侧约定兜底。

## 下一步（M4 剩余）

1. **Windows 代码签名**（OV/EV 证书接入后更新发布说明与更新器校验说明）。
2. 消息平台收消息（官方 WS 长连接，接官方 SDK）。
3. i18n 文案补全（机制已落，Feed 卡 / 审批印章 / 向导等剩余界面文案 key 化）。
4. 社区插件投稿与索引审核流程。

## 界面走查

```bash
npm run build
npm run shot          # 值台 → shots/desk.png
npm run shot -- review    # 审查台 → shots/review.png
npm run shot -- wizard    # 造铃向导 → shots/wizard.png
npm run shot -- x paper:light     # 纸墨亮色 → shots/desk.png（覆盖）
```

第 4 个参数是 `theme:mode`（`night|paper|celadon` × `dark|light`）。`scripts/preview-shot.cjs` 用一份假桥（`preview-preload.cjs`）喂空数据快照，页面自动落到设计稿示例图纸，便于逐像素对比。
