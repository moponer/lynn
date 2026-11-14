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

- 第三节「成员后台跑单侧」：读 src/main/member-runner.ts 后填写结论；未读则写「未核对」。
- 全文行号均来自上一轮代码级勘察（rg + read_file 实证），本轮未逐行复核；如后续发现行号漂移，以实际文件为准。
