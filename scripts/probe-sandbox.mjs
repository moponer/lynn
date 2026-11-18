#!/usr/bin/env node
/**
 * 打印当前机器的沙箱判定（P5-1b）。
 *
 * 为什么值得单独一条命令：沙箱是会**静默降级**的东西——helper 没构建、账户不支持
 * AppContainer、探针失败，任何一种都会让"已隔离"变成一句空话。这条命令让你随时能用
 * 一条命令问清楚"现在到底是哪一档、为什么"。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { probeSandbox } = require("../dist/main/sandbox.js");

const v = probeSandbox();
console.log(JSON.stringify(v, null, 2));
if (!v.probed) {
  console.log("\n⚠ 探针没跑成 → 按 off 处理（不是「不支持」，是「不知道」）");
  console.log("  先构建 helper：npm run build:native（需要 Rust 工具链）");
} else if (v.mode !== "appcontainer") {
  console.log("\n⚠ 实际档位不是 appcontainer：**断网与文件 ACL 隔离都没生效**。");
  console.log(`  原因：${v.reason}`);
  console.log("  jobonly 能挡的只有：进程数上限 / 内存上限 / 父死子死。");
}
process.exit(0);