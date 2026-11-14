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
