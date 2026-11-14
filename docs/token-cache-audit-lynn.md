# lynn 项目 token 缓存命中率勘察报告

## 摘要

1. 命中率**能算**，口径已落地：cacheRead / (sessionIn + cacheRead + cacheWrite)。
2. 但**只有直连路径有可回查的落盘台账**；生产主力 Pi 路径不写 usage.jsonl、cost 恒为 0，线上查不到。
3. 本仓库**不主动制造缓存断点**（请求体无 cache_control），能否命中完全取决于 provider 是否在 usage 里回报缓存字段。
4. 仓库内**没有任何 tokenizer 计数缓存 / 本地响应缓存**，token 计数 100% 依赖模型返回的 usage。
5. 最大缺口：Pi 路径补 usage 落盘 + 增加「端点是否回报缓存字段」标记（否则分不清「没命中」与「端点没报」）。

## 一、仓库结构梳理

- 形态：Electron 桌面应用（package.json：name=lynn，productName=Lynn，main=dist/main/main.js）。
- 构建与运行：`npm run build` = typecheck（tsc --noEmit）+ build:renderer（vite）+ build:main（tsc -p tsconfig.main.json && copy-assets）；`npm run test` = build:main + node --test；另有 perf:standby、live-check、check-pi-base 等脚本。
- 职责落点：
  - src/main/llm.ts —— 直连路径的模型请求出口与 usage 归一化。
  - src/main/kernel.ts —— Agent 循环内核，命中率计算、直连/Pi 两套用量记账、history 持久化。
  - src/shared/contract.ts —— 前后端共享契约，cacheHitRate 口径定义在此。
  - src/main/budget.ts —— 用量台账落盘（usage.jsonl）。
  - src/main/pi-rpc-host.ts —— Pi 运行时桥接（get_session_stats、modelsJsonFor、会话续接参数）。
  - src/renderer/desk/Desk.tsx、src/renderer/console/ConsoleDesk.tsx —— 界面侧命中率展示。
  - scripts/eval/ —— 命中率实测脚本（live.cjs、mock-model.cjs、backend.mjs）；perf/eval/ 为其输出目录。
  - tests/llm-retry.test.mjs —— usage 归一化单测。
- 运行期数据根在用户 home 下的 .lynn（不在仓库内）；仓库内只有 docs/、scripts/、tests/、perf/ 等。

## 二、模型请求链路

### 2.1 直连路径

- 唯一 HTTP 出口：src/main/llm.ts:103 的 streamChat() → src/main/llm.ts:113 的 fetch（${input.baseUrl}/chat/completions）。
- 请求体 src/main/llm.ts:118-127 只有 model / messages / stream / stream_options / tools / temperature：**没有 cache_control，没有 Anthropic 显式缓存断点，没有 prompt_cache_key**。
- 响应侧能拿到缓存命中字段：src/main/llm.ts:70-84 的 SseChunk.usage 同时声明三家命名——prompt_cache_hit_tokens（DeepSeek）、cache_read_input_tokens / cache_creation_input_tokens（Anthropic 兼容）、prompt_tokens_details.cached_tokens（OpenAI 兼容）。
- 归一化：src/main/llm.ts:156 cacheRead（三家字段依次 ?? 取值，缺省沿用上次值）；:159 cacheWrite = u.cache_creation_input_tokens ?? 0；:160 cacheMiss = u.prompt_cache_miss_tokens ?? 0（仅日志）。:157-158 注释说明 DeepSeek 的 miss 已含在 prompt_tokens 里，不重复记账（src/main/kernel.ts:5478-5482 同理）。
- 含义：本仓库是**被动读数**——命中与否取决于 provider 是否在 usage 里回这个字段；不主动制造断点，则 Anthropic 那种显式 cache_control 的缓存在这里拿不到 cache_read_input_tokens。

### 2.2 Pi 生产路径

- 字段来自官方 RPC get_session_stats：src/main/pi-rpc-host.ts:262-266 读 r.tokens.cacheRead / cacheWrite；:279-284 归一化（total ?? input + output + cacheRead + cacheWrite）。
- 落点：src/main/kernel.ts:5331-5362，用 host.stats() 的**会话累计值**做增量差（:5334-5338 的 dIn / dRead / dWrite），日志 kind = usage_round（:5355-5362，字段 in/out/cacheRead/cacheWrite/hitRate/turnHitRate）。

## 三、本地缓存层

- **前缀稳定性（有保障）**：技能注入改到当轮 user 消息尾部，不动 system prompt 与历史前缀（src/main/kernel.ts:5429-5437）；群内定向说明同理（:5420-5428）；src/main/kernel.ts:1119-1129 的 systemPrompt() 注释写明「技能注入不再拼在这里……否则整段 system prompt + 全部历史的前缀缓存就废」。
- **会话续接**：Pi 侧 --session-dir / --continue / --session-id（src/main/pi-rpc-host.ts:146-158）；src/main/kernel.ts:5279-5290 附近做 resume 判定与 sessionDir 计算；切换会话保留历史 :2060-2070；history 落盘 :2036-2053 persistThread()，切回恢复 :2042-2046。
- **没有响应缓存**：src/main/llm.ts 的 streamChat 每轮都是全新 fetch，无结果缓存；src/main/kernel.ts:5419 每轮把 this.history 全量重发。重复问同一句会全额重算。
- **没有 tokenizer / 计数缓存**：全仓检索 tokenizer|tiktoken|encoding_for|kv_cache|kvCache|prefix_cache|prefixCache|responseCache|response_cache 在 src/ agent/ scripts/ tests/ 中零命中（ripgrep 14.1.0，无输出）。token 计数 100% 依赖模型返回的 usage，本地无法预估 token。
- **成员后台跑单侧（本轮已复核，结论：没有单独记 cacheRead，成员侧命中率永久不可测）**：src/main/member-runner.ts:153-163 的 MemberRunResult 接口只有 turns / promptTokens / completionTokens 三个用量字段，**没有 cacheRead / cacheWrite**；:443-444 的累加只取 result.promptTokens 与 result.completionTokens，全文再未出现 cacheRead / cacheWrite / cacheMiss 任何一次读取——:295 的 chat 默认走 src/main/llm.ts 的 streamChat，其 StreamChatResult 明明带回 cacheRead / cacheWrite / cacheMiss（src/main/llm.ts:52/54/56），但成员侧从不取这三个值，缓存读数在此被直接丢弃：不写 usage 台账、不进成员回报、也不进界面命中率。另两点实测：成员走的是**直连路径**而非 Pi 路径，:314-322 的 messages 数组逐轮追加、每轮全量重发（前缀稳定）；请求体无 cache_control（src/main/llm.ts:117-125），成员单命中与否仍完全取决于端点是否在 usage 里回报缓存字段。**补法**：MemberRunResult 增加 cacheRead / cacheWrite 两个字段，:443-444 旁累加 result.cacheRead / result.cacheWrite，再由 src/main/kernel.ts 的 memberUsage 汇总处一并上报。（本轮实测行号，与正文其余章节引用的上一轮行号可能有个位偏移，以实际文件为准。）

## 四、命中率现状（三层）

### 4.1 能直接算出来的

- 公式：cacheHitRate = cacheRead / (sessionIn + cacheRead + cacheWrite)，定义在契约层 src/shared/contract.ts:311-315；prompt=0 时返回 undefined（界面隐藏，不显示假 0）。
- 直连路径落地：src/main/kernel.ts:5480-5484（hit / write / unhit 三分解，turnPrompt = promptTokens + write，算 turnHitRate），:5485-5494 累加进 this.usage，:5495-5502 打日志 usage_direct（含 cacheRead/cacheWrite/cacheMiss/hitRate），:5504-5512 落盘记账 → src/main/budget.ts:31-38 appendUsage() 写 <dataRoot>/logs/usage.jsonl，字段定义 src/main/budget.ts:17-30（UsageLine：in/out/model/cacheRead/cacheWrite）。
- Pi 路径落地：src/main/kernel.ts:5331-5362（增量差 + usage_round 日志）。
- 界面消费：src/renderer/desk/Desk.tsx:367-376、src/renderer/console/ConsoleDesk.tsx:1638-1639，同一公式，prompt=0 时隐藏。
- **数值现状**：仓库内**没有**真实 usage 记录样本（运行期数据根在用户 home 的 .lynn，不在仓库内），因此当前拿不到线上实测命中率；唯一可复现的数值来自 mock 常量——scripts/eval/mock-model.cjs:24-25 造 prompt_cache_hit_tokens: 900 / prompt_cache_miss_tokens: 300，对应 900/(900+300) = 75%，**这是由 mock 常量推导的样例值，不是线上实测**。

### 4.2 只能定性推断的

- 「命中与否」实际由两个不可控条件决定：(a) 端点是否在 usage 里回报缓存字段；(b) 前缀是否稳定。代码侧只能保证 (b)：尾部注入（src/main/kernel.ts:5420-5437）与按群独立 sessionDir 续接（src/main/pi-rpc-host.ts:146-158）都刻意不破坏前缀。结论只能写成「前缀稳定性有代码保障」，写不出具体命中率。

### 4.3 当前根本测不到的

- (a) **Pi 生产路径不写 usage 台账**：appendUsage 只在直连路径调用（src/main/kernel.ts:5504），线上主力路径没有可回查的命中率记录。
- (b) **cost 恒为 0**：src/main/pi-rpc-host.ts:73-89 的 modelsJsonFor() 把模型 cost 写死为 { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }，成本维度无从核算。
- (c) **无 tokenizer 计数**：任何「本地预估 token」都做不了。
- (d) **无请求侧缓存断点**：Anthropic 风格的显式前缀缓存在本仓库不可用。
- (e) **无本地响应 / 会话结果缓存**：重复请求全额重算。
- (f) **分不清「没命中」与「端点没报」**：没有任何埋点能区分这两种 0。

## 四之二 · 2026-11-14 实测补充（本报告部分结论已过时）

> 以下数据来自真模型调用，不是 mock 常量。探针：`scripts/live-usage-probe.cjs`（`npm run probe:usage`），用 Electron `safeStorage` 解密用户已配置的 Key（不打印），`max_tokens=16` 控制成本；结果落在 `shots/live-usage-probe.json`。

**1. 历史台账实测**（`C:\Users\Administrator\.lynn\logs\agent.log`，107 条 `usage_round`，11-10 16:03Z → 11-13 12:20Z）

| 指标 | 值 |
|---|---|
| 累计命中率 | p50 48% / 均值 53.3% / 最高 96.3%（被每日冷启动拉低） |
| 单轮命中率 | p50 47.6% / 最高 99.4%，长会话稳定在 97–99% |
| `cacheWrite` | **107/107 全为 0**（原因见下） |
| 11-13 末条累计 | 未命中输入 422,124 / 输出 88,460 / 命中 5,170,496，累计 92.5% |
| 一次真实断点 | 12:13:58 单轮掉到 50.3%，累计 `in` 一次增加 14 万 |

**2. 7 个已配置模型的端点探针**（每模型 1 次最小请求）

| 模型 | 结果 | prompt | hit | 回报的缓存字段 |
|---|---|---|---|---|
| anges-cn · agnes-3.0-flash | OK 775ms | 352 | 0 | `prompt_tokens_details` |
| MiniMax M3.1 Flash（默认） | OK 1142ms | 452 | 451 | `prompt_tokens_details` |
| OFM · DeepSeek V4.1 Flash | HTTP 429 | — | — | 免费额度用尽 |
| OFM · MiMo V2.6 Flash | HTTP 429 | — | — | 同上 |
| OFM · 推荐免费组 | HTTP 429 | — | — | 同上 |
| OFM · OpenRouter Free | OK 9327ms | 343 | 0 | `prompt_tokens_details` |
| OFM · Kilo Auto Free | OK 1839ms | 467 | 0 | `prompt_tokens_details` |

**`cacheWrite` 恒 0 的原因找到了**：所有可达端点都只回报 OpenAI 兼容的 `prompt_tokens_details.cached_tokens`，**没有一家回报** `cache_creation_input_tokens`（Anthropic 语义）或 DeepSeek 的 `prompt_cache_hit_tokens`。`cacheWrite` 为 0 是端点形态，不是缓存没工作；此前"命中率 0 不可判读"的担心对这批端点不成立——它们都报了字段。

**3. 前缀 A/B 对照：缓存分层的收益（真模型验证）**

同一 system（约 450 token）+ 固定历史，只改公告的落点；每轮记录 `cached_tokens`：

| 轮次 | MiniMax hit | anges hit |
|---|---|---|
| r1 / r2 稳定前缀 | 451 / 451 | 256 / 256 |
| **r3 公告进 system（旧方案）** | **128（-71.6%）** | 256 |
| r4 公告进 user 尾部（新方案） | 446 | 0 |
| r5 **改公告内容**（新方案） | **464（不掉）** | 256 |

MiniMax 上结论明确：旧方案改一次公告，缓存命中从 451 掉到 128；新方案放回 446/464，**且 r5 改公告文本仍保持命中**——这正是把易变段移出 `systemPrompt()` 要拿到的收益。anges-cn 的 r4 出现 0、r5 又回 256，属该网关缓存实现不稳定，记为端点差异，不拿来下结论。

**4. 本报告需要修正的过时结论**

| 原结论（11-13） | 现状（11-14） |
|---|---|
| §三「成员侧没有单独记 cacheRead，永久不可测」 | **已过时**：`MemberRunResult` 已有 `cacheReadTokens/cacheWriteTokens`，`member_exit` 日志带 `hitRate`；本轮再补了按次台账 `kind:"member"` |
| §4.3(a)「Pi 路径不写 usage 台账」 | **已修**：`usage_round` 处补 `appendUsage`，记**本轮增量**（不是会话累计值，避免逐行重复求和） |
| §4.3(f)「分不清没命中与端点没报」 | **已修**：`StreamChatResult.cacheFieldsReported` + 台账同名字段，端点报 0 与压根没报可区分 |
| §4.3(b)「cost 恒 0」 | **仍未修**：`modelsJsonFor()` 定价仍写死 0，金额维度依旧算不出来 |
| §4.3(e)「无响应缓存」 | **仍未修**：重复问题仍全额重算 |

新增埋点还有 `cacheBreakReason`（切群 / 运行时重建 / 冷启动），下次再出现 50.3% 那种断点可以直接回查原因，不用猜。

## 五、口径建议

- 定义：**token 缓存命中率 = cacheRead / (sessionIn + cacheRead + cacheWrite)**。
- 分子：只认 provider 回报的缓存读 token（三家字段归一化后的值）。
- 分母：该会话全部 prompt token（会话输入 + 缓存读 + 缓存写）。
- scope：单会话、单模型端点。
- **端点不回报缓存字段时，该值记为「不可测」，不记 0**（0 会被误读成「缓存完全没用上」）。

## 六、缺口与待办清单

| # | 缺什么 | 怎么补 | 落点 | 预估改动量 |
|---|---|---|---|---|
| 1 | Pi 路径没有 usage 台账 | 在 usage_round 块内调用 appendUsage() | src/main/kernel.ts:5355-5362 | 约 8-12 行 |
| 2 | cost 恒为 0 | modelsJsonFor() 填真实定价 | src/main/pi-rpc-host.ts:73-89 | 1 处结构改动 |
| 3 | 分不清「没命中」与「端点没报」 | 返回体加 cacheSupported 布尔，或日志加同名字段 | src/main/llm.ts:203-208 / src/main/kernel.ts:5355 | 各 1-3 行 |
| 4 | 不支持 Anthropic 显式前缀缓存 | 请求体注入 cache_control，类型加可选字段 | src/main/llm.ts:118-127、src/main/llm.ts:8-17 | 约 5-10 行 |
| 5 | 缺真实数值样本 | 在有 Key 的机器跑一次并把产物纳入仓库 | perf/eval/live-<stamp>.json（scripts/eval/live.cjs:88 产出） | 1 次运行 + 1 个样本文件 |

## 七、实测工具链（可复核）

- scripts/eval/live.cjs:59-77：用生产 Pi 路径跑 3 轮，逐轮读 session.snapshot().usage，prompt = sessionIn + cacheRead + cacheWrite，hitRatePct = cacheRead / prompt；:96-99 输出 cacheReported（是否有任一轮 cacheRead > 0 或 cacheWrite > 0）；结果落 perf/eval/live-<stamp>.json（:24-25、:88）。
- scripts/eval/mock-model.cjs:24-25 与 scripts/eval/backend.mjs:152：mock 端点造带缓存字段的 usage。
- tests/llm-retry.test.mjs:127-133：断言归一化（prompt_cache_hit_tokens: 900 → r.cacheRead === 900）。

## 八、本次未复核项

- 第三节「成员后台跑单侧」已复核：src/main/member-runner.ts 的 MemberRunResult 无 cacheRead / cacheWrite，成员侧命中率永久不可测（该条行号为该轮实测，可能有个位偏移）。
- 全文行号均来自上一轮代码级勘察（rg + read_file 实证），本轮未逐行复核；如后续发现行号漂移，以实际文件为准。
