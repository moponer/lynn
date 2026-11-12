# 风铃 Lynn 稳定性与商用能力评测报告

- 日期：2026-11-10 首测 / 2026-11-11 改进复测
- 评测对象：首测为 `7f11249` 之后的全部源码 + 评测脚本；复测包含本轮针对 P0/P1 的**业务代码改动**（`llm.ts`、`kernel.ts`、`App.tsx`、`Feed.tsx`、`main.ts`、`contract.ts` 等）
- 评测方式：**实际执行**，包含全量单测、真实 Electron 前端 E2E、真实模型调用、确定性 mock 模型压测、失败注入与重复运行
- 原始数据：`perf/eval/*.json`、`perf/eval/*.png`、`perf/eval/*.log`
- 结论先行（首测）：**功能覆盖与正确性达到可商用基线，异常恢复与资源占用尚未达到**；建议「受控 Beta 可用，通用商业发布暂缓」。
- 复测结论（§7）：**P0 的停止生成、429/5xx 重试、前端终态渲染已修复并实测达标；P1 的缓存口径、错误可行动、测试拆分已落地；内存仍高于建议基线**，结论调整为「受控 Beta 稳定，通用商业发布前仍需一次内存/冷启动专项」。
- 第二轮优化（§8）：**系统提示词冷轮 5008 → 3036 token（-39.4%）；首屏与内核 init 解耦；Pi 429/500 失败注入补测；100 轮短 soak 无失败、清理幂等**；内存经单进程/网络服务实验确认无法在不破坏稳定性的前提下压到 350 MB 以下。

---

## 1. 评测环境与方法

### 1.1 环境

| 项 | 值 |
|---|---|
| OS | Windows（本机 Administrator） |
| Node | v26.12.1 |
| Electron | 45.2.1 |
| UI | React 18 + Vite 5，渲染层 `dist/renderer` |
| LLM（真实） | MiniMax / `MiniMax-M3.1-Flash`，用户已配置密钥 |
| 浏览器自动化 | `playwright-core` 1.64.1，直接驱动 Electron 主进程 |
| 数据隔离 | 临时 `LYNN_HOME`、临时项目目录、临时 `userData`；mock 模型跑在**独立 Node 进程**，避免污染被测内核 CPU/内存 |

### 1.2 三条执行链路

1. **确定性后端链路**：`Kernel` + 本地 OpenAI 兼容 SSE mock（`scripts/eval/mock-model.cjs`）。
   通过 `NODE_TEST_CONTEXT=eval` 强制走直连降级路径，避免每个用例冷启动 Pi worker。
2. **真实前端链路**：Playwright `_electron` 启动 `scripts/eval/eval-main.cjs` → 真实 `dist/main/main.js` → 真实 IPC → 真实 React 渲染；模型仍接 mock，保证可重复。
   `eval-main.cjs` 在加载主进程前 `app.setPath("userData", 临时目录)`，隔离单实例锁、localStorage、safeStorage。
3. **生产模型链路**：`npm run live-check`（真实 Pi worker + 真实 MiniMax）与 `scripts/eval/live.cjs`（3 轮真实对话）。真实调用使用**临时数据根 + 复制加密配置 + 系统凭据库解密**，不污染用户会话，费用为 4 次极短对话。

### 1.3 静态基线（同轮执行）

- `npm run typecheck`：0 错误
- `npm run lint:design`：通过（零描边、四功能色、CSS 变量全部有定义）
- `npm run build:renderer`：成功，469 modules

---

## 2. 测试用例设计

| ID | 类别 | 用例 | 期望 |
|---|---|---|---|
| TC-01 | 正确率 | 全量 `npm test`（434 条） | 全部通过，无 skip/todo/cancel |
| TC-02 | 前端完整 | 12 项 E2E ×3 次 | 启动、对话、失败恢复、工作区菜单、命令面板、设置-数据页、台账、工单详情/交付物/证据、右键菜单、交付箱、控制台 `cd` 全部可操作 |
| TC-03 | 一致性 | 同一 prompt ×5 | 回复完全一致，延迟抖动小 |
| TC-04 | 一致性 | 核心后端用例 ×3、前端 ×3 | 通过率不下降，无控制台错误 |
| TC-05 | 正确率 | 真实模型 ×3「只回复两个字：收到」 | 3/3 指令遵循，回合 `busy=false` |
| TC-06 | 异常恢复 | HTTP 500 → 恢复；429；中止慢流；工具越界；office 未装配 | 错误可见、`busy` 回落、下一轮可成功、部分文本保留 |
| TC-07 | 异常恢复 | 前端失败可见并恢复 | 错误卡与恢复回复都进 DOM（或至少进权威快照） |
| TC-08 | 异常恢复 | Pi worker 崩溃 / 看门狗 / 工具抛错（全量单测内） | 挂起请求被拒、stderr 带出、不炸壳 |
| TC-09 | 性能 | 10 轮串行对话、8 并发成员循环 | 记录 TTFT/总延迟/吞吐/CPU/RSS |
| TC-10 | 资源 | Electron 空闲态 FPS、进程内存/CPU | 记录真实 `app.getAppMetrics()` |
| TC-11 | Token/缓存 | mock usage 字段 + 真实模型 session stats | 记录 in/out/cacheRead/cacheWrite/命中率 |
| TC-12 | 数据生命周期 | 清理、去重、卷宗 zip、审查快照（全量单测内） | 交付物/证据不动，过程文件按 TTL 删 |

---

## 3. 实测数据

### 3.1 任务完成度与正确率

| 项 | 实测 | 结论 |
|---|---|---|
| 全量单测 | **434 / 434 通过**，0 fail、0 cancelled、0 skipped、0 todo；总耗时 **244.4 s** | ✅ 100% |
| 前端 E2E | 3 次正式重复 ×12 步 = **36 / 36 通过**，0 失败步骤、0 console error | ✅ 100% |
| 确定性回复 | 5 次同一 prompt，`uniqueReplies=1`，全部等于预期串 | ✅ |
| 真实模型指令遵循 | 3/3 回复「收到」，`turn.busy=false` | ✅ |
| 工具边界 | `../不存在.txt` 被拒并给出可读原因；未装配 office 工具如实回报 | ✅ |
| 数据生命周期 | 超期 scratch/检查点/轮转日志被删；`artifacts/`、sandbox workspace、交付物不动 | ✅ |
| 卷宗导出 | 生成真实 zip（`PK\x03\x04` 本地头），含 `task.json`、`timeline.jsonl`、`artifacts/out.txt` | ✅ |
| 工件去重 | 同内容只存一份，同名不同内容各存一份 | ✅ |
| 审查快照 | 项目复制进 `tasks/<id>/workspace`，排除 `node_modules`，原项目未改，工单切 sandbox | ✅ |

> 前端 12 步明细（代表轮）：启动 73ms、对话 179ms、失败恢复 8348ms、播种/刷新 214ms、工作区菜单 59ms、命令面板 33ms、设置数据页 261ms、台账 41ms、详情 112ms、右键菜单 51ms、交付箱 59ms、控制台 `cd` 933ms。
> 截图证据：`perf/eval/ui-settings-*.png`、`perf/eval/ui-console-*.png`。

### 3.2 多次重复运行的一致性

| 轮次 | 后端核心用例 | 前端 E2E | 启动耗时 | 控制台错误 |
|---|---|---|---|---|
| 1 | 32/32，8.66 s | 12/12，5.75 s | 5.75 s | 0 |
| 2 | 32/32，17.13 s | 12/12，4.78 s | 4.78 s | 0 |
| 3 | 32/32，11.14 s | 12/12，3.27 s | 3.27 s | 0 |

- 后端通过率 **3/3 稳定为 100%**，耗时标准差 3.55 s（受机器负载影响）。
- 前端通过率 **3/3 为 100%**，启动耗时 3.27–5.75 s，标准差约 1.02 s。
- 同一 prompt ×5 延迟：36/16/22/17/21 ms，标准差 **7 ms**。
- **确定性缺陷**：3 次正式前端运行里，错误卡渲染 3/3 进 DOM，但「恢复后的回复」只有 **2/3** 进 DOM；第 3 次仅存在于权威快照（`session.snapshot.feed`），DOM 未刷新。全量 5 次成功运行中 4/5 正常。属于渲染层 rAF/可见性相关的偶发不一致。

### 3.3 失败与异常场景恢复

| 场景 | 实测 | 判定 |
|---|---|---|
| HTTP 500 | 15 ms 出错误事件 `端点返回服务端错误（5xx）`；400 ms 后 `busy=false`；下一轮成功（1070 ms，mock 慢流） | ✅ 错误可见、状态复位、可恢复 |
| HTTP 429 | 9 ms 出 `端点限流或额度不足（429）`；**请求数 = 1，无自动重试、未读 `Retry-After`** | ❌ 缺退避重试 |
| 中止慢流 | 保留已产出文本「收到。」；`busy=false`；但 **abort→stop = 704 ms**，等于剩余流耗完 | ❌ 直连路径未把 `AbortSignal` 传给 `fetch` |
| 工具越界 | 0 ms 拒，错误文案含「路径越界…让用户右键授权只读目录」 | ✅ |
| office 未装配 | 如实回报「当前进程没有 office 引擎桥接」 | ✅ |
| 前端 500→恢复 | 错误卡 3/3 在快照中可回查；恢复回复 2/3 进 DOM | ⚠️ 渲染偶发不一致 |
| Pi worker 崩溃 / 看门狗 | 全量单测中 728 ms / 782 ms 通过，挂起请求被拒、stderr 带出 | ✅ |

**代码级定位**

- `src/main/llm.ts:94` 的 `streamChat` 已支持 `signal`，但 `src/main/kernel.ts` 的 `runChatDirect` 调用时未传；`session.abort` 只能等当前流自然结束。
- 直连路径对 429/5xx 直接 `failTurn`，没有 `Retry-After` / 指数退避；Pi 路径由 worker 负责，本次未注入失败验证。
- 前端 `App.tsx` 对 `delta` 做 rAF 合帧；窗口不可见/后台时节流会让终态卡片停留在快照而不落 DOM。

### 3.4 前端能力完整覆盖

| # | 前端测试项 | 结果 |
|---|---|---|
| 1 | Electron 启动到值台主界面（`composer-in`、`rail-seg`） | ✅ |
| 2 | 输入框发送 → 用户卡 + 助手流式回复渲染 | ✅ |
| 3 | 顶栏工作区菜单：换工作区 / 不用工作区 / 添加只读目录 / 撤权 | ✅ |
| 4 | Ctrl+K 命令面板含 3 个工作区动作 | ✅ |
| 5 | 设置 → 数据页：默认工作区、常用只读根、总占用、一键清理 | ✅ |
| 6 | 工单台账显示播种的工单（含状态、成员、证据数） | ✅ |
| 7 | 工单详情「证据」页：交付物区 + 证据链区 + report.md | ✅ |
| 8 | 工单右键菜单：导出卷宗 zip、拷进任务沙箱跑测试 | ✅ |
| 9 | 左栏「交付箱」跨任务汇总交付物 | ✅ |
| 10 | 控制台视图切换（官方 `lynn.view.console` 插件） | ✅ |
| 11 | 控制台 `cd --none` 回执显示「这次不用工作区」 | ✅ |
| 12 | 前端失败注入（500）与恢复（新回复） | ✅（快照 3/3，DOM 2/3） |

> 说明：早期评测脚本曾与用户日常实例共享 `userData`；已改为 `eval-main.cjs` 隔离。共享期间曾 `localStorage.clear()`，若用户实例重启后发现视图偏好变化，重新在界面选一次即可。

### 3.5 基础能力指标

#### 3.5.1 延迟与吞吐（确定性 mock，内核直连）

| 指标 | 实测 |
|---|---|
| Kernel `init` 冷启动 | **437 ms** |
| 10 轮串行 TTFT | P50 **7 ms**，P95 **104 ms** |
| 10 轮总延迟 | P50 **13 ms**，P95 **109 ms** |
| 串行吞吐 | **40.25 turns/s**（10 轮 / 248 ms） |
| 8 并发成员循环 | **766.3 tasks/s**，8/8 reported，wall 10 ms |
| 串行 10 轮 CPU | 250 ms CPU / 248 ms wall ≈ **100% 单核**（本地 SSE 解析 + 状态更新）；进程总 CPU 282 ms |
| 内存增量 | RSS **+18.6 MB**，heap **+5.7 MB** |

#### 3.5.2 真实模型（生产 Pi 路径，MiniMax-M3.1-Flash）

| 轮 | TTFT | 总延迟 | turnIn | turnOut | cacheRead | 累计命中率 | 回复 |
|---|---|---|---|---|---|---|---|
| 冷启动 `live-check` | — | 成功 | 5008 | 3 | 0 | 0%（未命中缓存） | 收到 |
| 1 | 3589 ms | 3761 ms | 144 | 3 | 4864 | 97.1% | 收到 |
| 2 | 2695 ms | 2869 ms | 160 | 3 | 9728 | 97.0% | 收到 |
| 3 | 2394 ms | 2570 ms | 177 | 3 | 14592 | 96.8% | 收到 |

- P50 总延迟 **2869 ms**；3 轮合计计费外显 token **490**（144+3+160+3+177+3）。
- 冷启动首轮输入约 **5008 tokens**（系统提示词/人设/技能/工具面），之后前缀缓存命中约 **4864 tokens/轮**，未命中输入降到 144–177 tokens。
- 真实模型吞吐约 **0.33 turns/s**，瓶颈完全在供应商，不是本地内核。

#### 3.5.3 前端资源与流畅度（真实 Electron）

| 指标 | 实测（3 次正式重复） |
|---|---|
| 启动到主界面 | 3271 / 4778 / 5745 ms |
| 空闲 1s 帧数 | 60 / 61 / 61 FPS |
| 进程常驻内存合计 | **566.3 / 569.4 / 580.8 MB**（Browser + GPU + Utility + Tab） |
| 空闲 CPU | 0% |
| DOMContentLoaded / loadEvent | 30–86 ms |
| DOM 节点数 | 171–182 |
| 控制台错误 | **0 / 0 / 0** |

#### 3.5.4 Token 与缓存记账

- mock 端点返回 `prompt_tokens=1200`、`prompt_cache_hit_tokens=900`、`prompt_cache_miss_tokens=300`：内核记录 `sessionIn=300`、`cacheRead=900`、`cacheWrite=300`。
- 直连路径把「未命中输入」同时计入 `sessionIn` 与 `cacheWrite`，按现有 `cacheHitRate` 公式得 **60%**（900/1500），存在口径重复。
- Pi 真实路径会话统计是**累计值**，命中率 96.8–97.1% 为累计口径，不是单轮增量。

---

## 4. 与商用标准的对比

> 下表是**改进前基线**；修复后的逐项复测结论见 §7。
>
> 下表基线为「桌面 AI 助手受控商用 / 公开 Beta 的建议阈值」，非绝对行业强制标准。

| 维度 | 建议基线 | 实测 | 判定 |
|---|---|---|---|
| 功能正确率 | ≥99% | 434/434 单测、36/36 前端步骤 | ✅ 达标 |
| 指令遵循（真实模型） | ≥95% | 3/3 | ✅ 达标 |
| 重复运行一致性 | ≥99%，无状态残留 | 后端 3/3、前端 3/3 通过；DOM 终态 2/3 | ⚠️ 部分达标 |
| 本地交互延迟 | P95 <200 ms | 109 ms（mock） | ✅ 达标 |
| LLM TTFT | P95 <2 s | 冷 3589 ms，暖 2394–2695 ms | ❌ 未达标（供应商侧为主） |
| LLM 总延迟 | P95 <4 s | 2570–3761 ms | ✅ 达标 |
| 本地吞吐 | >10 turns/s | 40.25 turns/s；766 tasks/s | ✅ 达标 |
| 空闲 CPU | <2% | 0% | ✅ 达标 |
| 空闲内存 | <300 MB | 566–581 MB | ❌ 未达标 |
| 空闲 FPS | ≥55 | 59–61 | ✅ 达标 |
| 应用冷启动 | <3 s | 3.27–5.75 s | ⚠️ 略超 |
| 错误可见性 | <1 s 且状态复位 | 9–15 ms，`busy=false` | ✅ 达标 |
| 429/5xx 恢复 | 自动退避重试 | 无重试 | ❌ 未达标 |
| 停止生成 | <200 ms 真取消 | 704 ms（等流跑完） | ❌ 未达标 |
| 缓存命中率 | ≥80% | 真实 Pi 累计 96.8–97.1% | ✅ 达标 |
| 控制台错误 | 0 | 0 | ✅ 达标 |
| 全量回归时长 | <5 min | 244.4 s | ✅ 达标（但 Pi 冒烟偶发超时） |

**综合判定**：`功能/正确性/边界/缓存/流畅度` 已达商用基线；`异常恢复、内存、冷启动、前端终态渲染一致性` 是发布阻塞项。建议 **受控 Beta 可用，通用商业发布暂缓**。

---

## 5. 改进建议（按优先级）

### P0（发布阻塞）

1. **真取消生成**：`runChatDirect` 为每轮创建 `AbortController`，把 `signal` 传给 `streamChat`；`session.abort` 立即 `abort()`。同理检查 Pi 路径的 `host.abort()`。目标 stop <200 ms。
2. **429/5xx 自动退避**：在 `streamChat` 外包一层 `retryChat`：读 `Retry-After`、指数退避 + 抖动、最多 3 次、仅对幂等请求；失败落审计并给「重试」按钮。
3. **前端终态渲染一致性**：`done`/`error` 卡片绕开 rAF 合帧或强制 flush；`document.hidden` 时直接 `setState`；`FeedView` 的 `collapseHistory` 不得折叠最后一张终态卡。补一条「窗口后台时发消息」的 E2E。
4. **内存瘦身**：当前 4 个 Electron 进程合计 566–581 MB。优先合并 Utility / 延迟 GPU 进程、按需加载 preload 中的大模块、检查字体与头像资源是否重复驻留；目标 <350 MB。

### P1（商用体验）

5. **缓存口径修正**：`sessionIn` 与 `cacheWrite` 不再重复计入未命中 token；补「单轮命中率」而非只给累计值；mock 与 Pi 两条路径统一。
6. **降低冷启动 token**：首轮 5008 输入 token 偏高。把系统提示词静态前缀固定并缓存，技能/人设/工具面按需注入，避免每轮全量拼接。
7. **错误信息可行动**：`端点返回服务端错误（5xx）` 应带状态码、端点 host（不含 Key）、是否会自动重试、一键重试动作。
8. **冷启动优化**：3.27–5.75 s；预构建 renderer、避免 GPU disk cache 冷创建错误、把 office/插件探测延后到首条消息之后。
9. **测试稳定性**：`npm test` 244 s，Pi 真链路冒烟在全量并发下曾 90 s 超时（单跑 8.3 s 通过）。拆成 fast/slow 两套，slow 单独 CI；`pi-rpc-smoke` 保留 180 s 超时并标记 `@slow`。

### P2（可观测与长期）

10. 增加 24h soak：内存增长、FD 泄漏、session 文件膨胀、清理器重复执行幂等。
11. 增加多模型/多端点故障注入（超时、半截 SSE、乱序 chunk、usage 缺失）。
12. 增加用户数据隔离回归：确保任何评测/预览入口都走 `eval-main.cjs`，不碰真实 `userData`。

---

## 6. 局限与复现

**局限**

- 真实模型只测了已配置的 MiniMax 一个端点、4 次短对话；未覆盖 DeepSeek/GLM/Kimi/Qwen/Ollama、长上下文、工具调用链的真实模型行为。
- 失败注入只覆盖内核直连路径；Pi worker 路径的 429/5xx 重试未实测。
- 未做 macOS/Linux、多用户并发、24h 以上浸泡、安全渗透、计费对账。
- 前端资源采样为空闲态；未做长时间高负载流式渲染的 CPU/内存曲线。
- 评测早期脚本曾共享用户 `userData`；正式数据均来自隔离后的 `eval-main.cjs` 运行。

**复现命令**

```bash
npm run typecheck
npm run lint:design
npm test                                   # 复测 439 条
npm run test:fast                          # 413 条，排除真 Pi/Edge/心跳慢测
npm run test:slow                          # 6 个慢测文件
node scripts/eval/backend.mjs              # 后端指标/失败注入
node scripts/eval/ui.cjs                   # 前端 12 步 E2E
node scripts/eval/repeat.mjs               # 后端 ×3 + 前端 ×3
npm run live-check                         # 真实模型生产链路
npx electron scripts/eval/live.cjs         # 真实模型 3 轮延迟/token/缓存
LYNN_LOW_MEMORY=1 node scripts/eval/ui.cjs # 低内存模式对比
```

**原始数据**

| 文件 | 内容 |
|---|---|
| `perf/eval/backend-20261110160303.json` | 后端延迟/吞吐/CPU/内存/失败恢复/一致性/工具失败 |
| `perf/eval/live-20261110160358.json` | 真实模型 3 轮逐轮数据 |
| `perf/eval/ui-20261110161836.json`、`ui-20261110162106.json`、`ui-20261110162115.json` | 3 次正式前端 E2E |
| `perf/eval/repeat-20261110162028.json` | 重复运行汇总 |
| `perf/eval/ui-settings-*.png`、`ui-console-*.png` | 设置页 / 控制台截图证据 |
| `perf/eval/*.log` | 原始执行日志 |

---

## 7. 改进落地与复测（2026-11-11）

> 本节全部为**改完代码后重新执行**得到的结果，不是推演。首测判定保留在 §3–§5，便于前后对照。

### 7.1 已完成的改进

| 优先级 | 改进 | 落点 | 状态 |
|---|---|---|---|
| P0-1 | 停止生成真取消：`AbortController` 合成「用户停止 + 120s 超时」，`session.abort` 立即 abort fetch/SSE | `src/main/llm.ts`、`src/main/kernel.ts` | ✅ |
| P0-1 | 429/5xx/网络错误自动退避：读 `Retry-After`、指数退避 + 抖动、最多 3 次、只重试「未吐字」的失败、落 `llm_retry` 审计并出可见提示卡 | `llm.ts` `streamChatWithRetry`、`kernel.ts` | ✅ |
| P0-2 | 终态卡片一致性：终态 `card`/`done`/`error` 前丢弃未执行的 rAF delta；`refresh` 加序号防旧响应覆盖；带动作的错误卡从折叠历史里置顶 | `App.tsx`、`Feed.tsx` | ✅ |
| P1 | 缓存口径：DeepSeek `prompt_cache_miss_tokens` 不再重复记入 `cacheWrite`；新增 `cacheMiss`（仅日志）与 `UsageView.turnHitRate` 单轮命中率 | `llm.ts`、`contract.ts`、`kernel.ts` | ✅ |
| P1 | 错误可行动：错误卡带 HTTP 状态、端点 host、自动重试次数、下一步「重试 / 设置」 | `kernel.ts` | ✅ |
| P1 | 测试稳定性：`npm run test:fast` / `test:slow` 拆分，慢测不再拖累 CI；拆包脚本改名避免被 `node --test` 当用例递归执行 | `scripts/split-tests.mjs`、`package.json` | ✅ |
| P1 | 低内存可选项：`LYNN_LOW_MEMORY=1` 关闭独立 GPU 硬件合成（默认不变） | `src/main/main.ts` | ✅（部分） |
| P1 | 新增 5 条回归用例覆盖重试/取消/缓存 | `tests/llm-retry.test.mjs` | ✅ |

### 7.2 改进前后对比（同一套实测脚本）

| 指标 | 改进前 | 改进后 | 判定 |
|---|---|---|---|
| 429 | 立即失败，1 次请求，9 ms 报错 | 读 `Retry-After` 后重试成功，**2 次请求**，2104 ms（含 1s 等待 + 慢流） | ✅ 达标 |
| 500 | 15 ms 泛化报错「端点返回服务端错误（5xx）」 | 3 次退避后仍失败；错误含 `HTTP 500`、端点 host、`已自动重试 2 次`、重试动作；`busy=false` | ✅ 达标 |
| 停止生成 | 704 ms（等剩余流跑完） | **64 ms**，保留已产出文本，`busy=false` | ✅ 达标（<200 ms） |
| 前端恢复回复进 DOM | 2/3 | **3/3**（`chatRenderedInDom` 与 `recoveryRenderedInDom` 均 3/3，0 console error） | ✅ 达标 |
| 缓存口径 | `cacheWrite=300`，累计命中率 60%（miss 被双记） | `cacheWrite=0`、`cacheMiss=300`，**单轮命中率 75%** | ✅ 达标 |
| 全量单测 | 434/434，244.4 s | **439/439，72.9 s**；fast 413/413、60.7 s | ✅ 达标 |
| 重复一致性 | 后端 3×32/32、前端 3×12/12；延迟 stdev 7 ms | 后端 3×32/32（耗时 stdev 873 ms）、前端 3×12/12；同 prompt 5 次 stdev **2 ms** | ✅ 提升 |
| 后端 TTFT / 吞吐 | P50 7 ms、P95 104 ms；40.25 turns/s | P50 9 ms、P95 80 ms；**43.1 turns/s**；成员并发 941 tasks/s | ✅ 基本持平 |
| 真实模型生产链路 | `LIVE-CHECK: OK` | 复测 `LIVE-CHECK: OK`，`turnHitRate=0`（冷轮如实为 0） | ✅ 无回归 |
| Electron 内存 | 566–581 MB | 默认 566–581 MB；`LYNN_LOW_MEMORY=1` **550.2 MB**（GPU 从 ~161 MB 降到 113.6 MB） | ⚠️ 仍高于 <350 MB 基线 |
| UI 启动 | 3.27–5.75 s | 2.99–8.05 s（一次冷启动 8.05 s） | ⚠️ 抖动仍大 |

### 7.3 仍未完成 / 需专项

1. **内存**：默认 550–580 MB，主要由 Chromium 四进程基线构成（Browser ~150 / GPU ~114–161 / Utility ~91 / Tab ~149–193）。低内存开关只省 ~20 MB，达不到 <350 MB。需要架构级改造：合并/延迟 Utility、收敛 renderer 常驻模块、按需加载字体与头像资源、评估 `--single-process` 的稳定性风险。
2. **冷启动**：2.99–8.05 s，首次冷启动仍超过 3 s 目标；需预构建/预热 renderer、延后 office 与插件探测、消除 GPU disk cache 冷创建错误。
3. **系统提示词 token**：冷轮约 5000 输入 token 未压缩 —— **已在 §8 压缩到 3036**；多模型 A/B 仍待做。
4. **Pi 路径失败注入**：本次只验证了直连路径的 429/5xx 重试 —— **已在 §8 补测 Pi worker**：429 会重试、500 会退避后报错。
5. **长时浸泡**：24h soak 仍未做；**已在 §8 补 100 轮短 soak**（含强制 GC 与清理幂等）。

### 7.4 复测结论

- P0 三项发布阻塞中，**停止生成、自动重试、前端终态一致性已解除**；
- P1 可观测性/错误 UX/测试拆分已落地；
- 唯一仍卡商用基线的是**内存与冷启动**，属于资源专项而非功能正确性。
- 综合结论更新为：**受控 Beta 可稳定运行；通用商业发布前补一次「内存 + 冷启动 + 系统提示词」专项即可，不再有功能性发布阻塞。**

### 7.5 复测原始数据

| 文件 | 内容 |
|---|---|
| `perf/eval/backend-20261111000338.json` | 改进后延迟/吞吐/资源/重试/取消/缓存口径 |
| `perf/eval/repeat-20261111000407.json` | 后端 ×3 + 前端 ×3 一致性 |
| `perf/eval/ui-20261111000438.json`、`ui-20261111000453.json`、`ui-20261111000502.json` | 3 次正式前端 E2E（DOM 终态 3/3） |
| `perf/eval/ui-20261111000744.json` | `LYNN_LOW_MEMORY=1` 对比 |
| `tests/llm-retry.test.mjs` | 新增 5 条回归用例 |

---

## 8. 第二轮优化与复测（2026-11-11 续）

> 针对 §7.3 里剩下的四项，逐项做代码改动并重新执行测试；不是理论推演。

### 8.1 系统提示词 / 工具面 token（已优化）

**改动**

- `src/main/persona.ts`：固定头从 27 行压成 8 条要点，固定尾从 10 行压成 5 条；保留「指挥者」「安全边界强制后置」「不要假装执行」等测试契约。
- `src/main/kernel.ts`：新增 `COMPACT_TOOL_JSON` —— 完整工具定义仍保留在 `TOOL_JSON` 供执行/测试/文档使用，发给模型时换成紧凑描述：15 个工具各一句短说明，参数描述只保留 `brief` / `tools`（四段简报与白名单规则已在 system prompt 里），`TEAM_HINT` 从 60 字缩到 16 字。
- `scripts/eval/prompt-size.mjs`：本地量化 system + tools 体积，不调模型。

**实测**

| 项 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| system prompt | 2143 chars / ~974 est tokens | **946 chars / ~430 est tokens** | -56% |
| tools JSON | 7255 chars / ~3298 est tokens | **4842 chars / ~2201 est tokens** | -33% |
| 合计估算 | ~4272 est tokens | **~2631 est tokens** | -38% |
| **真实模型冷轮输入** | **5008 tokens** | **3036 tokens** | **-39.4%** |
| 真实模型暖轮未命中输入 | 144–177 | 236–253（历史累积） | 同量级 |
| 真实模型 3 轮合计 token | 490（冷缓存已预热） | 3534（含 3036 冷轮） | 冷启动必经 |

- 真实模型复测：`live-20261111003535.json`，3/3 回复「收到」，P50 总延迟 2944 ms。冷 TTFT 4620 ms、暖 2411–2781 ms，与首测同一供应商抖动范围，压缩提示词没有引入回归。
- 关键行为回归：`persona` / `tool-surface` / `cache-friendly` / `brief-gate` 共 22 条通过；全量 439 条通过。

### 8.2 冷启动（已解耦，瓶颈定位到 Chromium）

**改动**

- `src/main/main.ts`：窗口、托盘、全局热键、更新器、RPC 通道先起；`kernel.init()`（office 探测 / L1 插件 / MCP / 清理 / 定时器）改为**后台执行**，不再 `await` 后才 `createWindow()`。L1/MCP 指纹变化会让下一条消息自动重建 Pi worker，能力不丢。
- 追加 `app.commandLine.appendSwitch("disable-gpu-shader-disk-cache")`，消除本机反复出现的 `Gpu Cache Creation failed` 磁盘重试。

**实测**（3 次正式重复，`repeat-20261111004054.json`）

| 轮 | 启动到主界面 |
|---|---|
| 1 | 6413 ms |
| 2 | 4634 ms |
| 3 | 3629 ms |

- 均值 4.89 s、标准差 1.15 s；与优化前 3.27–5.75 s（均值 4.60 s）基本持平，说明**内核 init 不是主瓶颈**，真正耗时在 Chromium 多进程创建与首屏渲染。
- 收益是结构性的：首屏不再被插件/MCP/office 探测阻塞（后端实测 `kernel.init()` 约 0.5 s），偶发冷启动长尾不再能拖住窗口出现。
- 12 步前端 E2E 3/3 全过，0 console error，DOM 终态 3/3。

### 8.3 内存（专项实验，结论：不能靠开关达标）

| 配置 | 总内存 | 进程构成 | 结果 |
|---|---|---|---|
| 默认 | 566–581 MB | Browser ~150 / GPU ~161 / Utility ~91 / Tab ~150–193 | 基线 |
| `LYNN_LOW_MEMORY=1` | 550.2 MB | GPU 降到 113.6，但 Tab 升到 193 | 只省 ~20 MB |
| `disable-features=NetworkService,NetworkServiceInProcess` | 572.8 MB | Utility 仍是 91.6 MB | 开关无效 |
| `--single-process`（实验） | — | `firstWindow` 直接崩 | **不可用** |

- 结论：350 MB 目标对当前 Electron 多进程架构不现实；强行单进程会崩溃。
- 保留 `LYNN_LOW_MEMORY=1` 作为显式可选项，但**不宣称达标**。要真正降内存需架构改造（合并/延迟 Utility、收敛 renderer 常驻模块、按需加载字体/头像资源），属于发布前专项，不是本轮能安全完成的功能改动。

### 8.4 Pi 真 worker 失败注入（补测完成）

`scripts/eval/pi-fail.cjs` 用临时数据根 + mock 端点 + 真实 Pi worker（显式删掉 `NODE_TEST_CONTEXT`）。

| 场景 | 结果 | 请求数 | 收敛时间 |
|---|---|---|---|
| 429 一次后恢复 | `done`，回复「收到」 | **2** | 6853 ms |
| 持续 500 | `error`，文案含 `500: mock upstream exploded` | **4**（worker 自己退避重试 3 次） | 15255 ms |

- 说明直连路径与 Pi 路径**各有重试**：直连由 `streamChatWithRetry` 负责（§7），Pi 由 worker 内部负责；两条路径都不会把失败伪装成成功。
- 事件到达瞬间 `turn.busy` 仍为 true（异步回落），不影响后续回合；UI 已在 §7 验证 `busy` 最终复位。

### 8.5 100 轮短 soak（补测完成）

`scripts/eval/soak.mjs`（`node --expose-gc`）：

| 指标 | 实测 |
|---|---|
| 连续对话 | **100 / 100 成功**，0 failed |
| 延迟 | P50 18 ms、P95 30 ms、max 223 ms |
| RSS | 61.2 → 87.1（前 50 轮）→ 91.3（后 50 轮）→ 89.7（强制 GC 后） |
| 增长形态 | 前 50 轮 +25.9 MB，后 50 轮仅 **+4.2 MB**：是 V8/JIT 预热，**不是线性泄漏** |
| heap | 增长 7.6 MB，GC 后 14 MB |
| 会话文件 | `context.json` 5.3 KB、`timeline.jsonl` 16 KB（100 轮） |
| 清理幂等 | 第一次释放 2048 B / 删 1 项，第二次 **0 B / 0 项**；scratch 已删、artifacts 未动 |
| 模型请求 | 100（一轮一次） |

> 仍未做 24h soak、FD 计数、多用户并发；需要长时间挂机台。

### 8.6 第二轮后的商用判定

| 维度 | 状态 |
|---|---|
| 功能正确率 | ✅ 439/439 单测、36/36 前端步骤、100/100 soak |
| 异常恢复 | ✅ 直连 + Pi 双路径 429/5xx、停止 64 ms、worker 崩溃 |
| 一致性 | ✅ 3× 后端 / 3× 前端 / 5× 同 prompt |
| Token 成本 | ✅ 冷轮 -39.4%（5008 → 3036） |
| 缓存命中 | ✅ 真实模型暖轮 96%+ 累计；单轮口径已补 |
| 冷启动 | ⚠️ 结构性解耦完成，但 3.6–6.4 s 仍超 3 s 目标（Chromium 基线） |
| 内存 | ❌ 550–581 MB，仍超 350 MB；单进程不可用，需架构专项 |
| 长时稳定性 | ✅ 100 轮短 soak 无线性泄漏、清理幂等；24h 未做 |

**最终结论**：功能性发布阻塞已全部解除；**通用商业发布前只剩「Electron 内存架构 + 冷启动」一个资源专项**，另建议补 24h soak 与多模型 A/B。受控 Beta 可以稳定跑。

### 8.7 第二轮原始数据与复现

```bash
node scripts/eval/prompt-size.mjs                       # 提示词/工具面体积
npx electron scripts/eval/live.cjs                      # 真实模型冷轮 token
node scripts/eval/repeat.mjs                            # 后端 ×3 + 前端 ×3
PI_FAIL_MODE=retry429 npx electron scripts/eval/pi-fail.cjs
PI_FAIL_MODE=fail500  npx electron scripts/eval/pi-fail.cjs
node --expose-gc scripts/eval/soak.mjs                  # 100 轮短 soak
LYNN_LOW_MEMORY=1 node scripts/eval/ui.cjs              # 低内存对比
```

| 文件 | 内容 |
|---|---|
| `perf/eval/live-20261111003535.json` | 压缩后真实模型 3 轮 token/延迟/缓存 |
| `perf/eval/repeat-20261111004054.json` | 解耦首屏后 3 次前端启动与一致性 |
| `perf/eval/ui-20261111003939.json`、`ui-20261111004521.json` | 首屏优化 / 网络服务开关实验 |
| `perf/eval/pi-fail-retry429-20261111004704.json`、`pi-fail-fail500-20261111004821.json` | Pi 真 worker 失败注入 |
| `perf/eval/soak-20261111005041.json` | 100 轮短 soak + 清理幂等 |
| `perf/eval/ui-20261111004355-FAILED.json` | `--single-process` 崩溃证据（不可采用） |

