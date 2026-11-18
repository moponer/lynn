# bench · 基准任务集

> 用途：给"优化有没有用"一把尺子。评分规则见 `docs/plan/19-benchmark.md`。

## 目录

```
bench/
  baseline.json        基线（npm run bench:baseline 生成）
  tasks/               10 个任务定义 + index.json
  fixtures/            素材（脚本生成，不入库二进制）
    make.mjs           生成全部素材
  checks/              每个任务的自动评分脚本（待实现）
```

## 命令

```bash
npm run bench:baseline    # 重算基线（只读日志，不跑模型）
npm run bench:score       # 打印当前指标
node bench/fixtures/make.mjs   # 生成/重建素材
```

## 素材（确定性生成）

| 任务 | 素材 | 说明 |
|---|---|---|
| B1 | `input/sales.csv` | 含合计行，评分要对数字 |
| B2 | `fixtures/repo-b2/` | `sum([])` 返回 NaN 的小仓库，`npm test` 可跑 |
| B4 | `fixtures/web/list.html` | 5 行表格，`file://` 打开 |
| B5 | `fixtures/rename/` | 200 个 `IMG_0001.JPG` |
| B6 | `fixtures/repo-b6/` | `slugify` 未实现完整的小仓库 |

## 评分口径

| 指标 | 规则 |
|---|---|
| 成功 | `task.json.status=done` 且 exit 为 reported 且报告 ≥300 字 且（有交付物或 explore） |
| 首轮成功 | 该单第一次 exit 即满足上述条件 |
| 无交付物 | `deliverables=0`（证据不算交付） |
| 命中率 | `cacheRead / in`，成员与巡检分开 |
| 复用 | 10 个任务至少 8 个全自动评分；主观项（排版美感）单独人工打分 |

## 注意

- 素材全部由 `make.mjs` 生成：不要手动改，也不要提交大文件。
- 跑任务会真实消耗 token，`bench:full` 不要放进每次 CI；冒烟只跑 `B2` + `B10`。
