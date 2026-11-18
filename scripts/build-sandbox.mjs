#!/usr/bin/env node
/**
 * 构建原生沙箱 helper 并放到 dist/（P5-1b）。
 *
 * 为什么单独一个脚本而不是塞进 build:main：
 *  - 它需要 Rust 工具链。没装 Rust 的机器不该因此跑不了 `npm run build`——
 *    沙箱是**可选增强**，缺了它应用照常工作（降级到现有工具层边界，并如实标注）。
 *  - `--offline` 是有意的：这个 crate **零依赖**，不该为了编译去连 crates.io。
 *
 * 用法：
 *   node scripts/build-sandbox.mjs          构建 + 拷贝 + 跑一次探针
 *   node scripts/build-sandbox.mjs --skip   只跑探针（不构建）
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const crate = path.join(repo, "native", "sandbox-exec");
const distExe = path.join(repo, "dist", "sandbox-exec.exe");
const builtExe = path.join(crate, "target", "release", process.platform === "win32" ? "sandbox-exec.exe" : "sandbox-exec");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}

if (process.platform !== "win32") {
  console.log("[sandbox] 只在 Windows 上构建（AppContainer / Job Object 都是 Win32 API）；其他平台跳过。");
  process.exit(0);
}

if (!process.argv.includes("--skip")) {
  if (!fs.existsSync(crate)) {
    console.log("[sandbox] native/sandbox-exec 不存在，跳过");
    process.exit(0);
  }
  const probe = run("cargo", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    console.warn("[sandbox] 没有 cargo（Rust 工具链）→ 跳过原生沙箱构建。应用会降级到工具层边界，这是**如实标注**而不是静默。");
    process.exit(0);
  }
  const res = run("cargo", ["build", "--release", "--offline"], { cwd: crate });
  if (res.status !== 0) {
    console.error("[sandbox] cargo build 失败");
    process.exit(res.status ?? 1);
  }
}

if (!fs.existsSync(builtExe)) {
  console.log("[sandbox] 还没构建过（缺可执行文件），跳过拷贝");
  process.exit(0);
}
fs.mkdirSync(path.dirname(distExe), { recursive: true });
fs.copyFileSync(builtExe, distExe);
console.log(`[sandbox] 已拷贝 → ${path.relative(repo, distExe)}（${(fs.statSync(distExe).size / 1024).toFixed(0)} KB）`);

// 构建完立刻探一次：能力不可用时**现在就说**，别等线上跑单才发现全是降级
const probeRun = spawnSync(distExe, ["--probe"], { encoding: "utf8" });
if (probeRun.status !== 0) {
  console.warn("[sandbox] 探针执行失败：", (probeRun.stderr || "").trim().slice(0, 200));
} else {
  try {
    const v = JSON.parse(probeRun.stdout.trim());
    // 注意：这里读的是 provisioned / launchVerified，不是「能建 profile 就算通过」——
    // 那是两件事，混淆会让人以为已经隔离了。
    console.log(`[sandbox] 探针：provisioned=${v.provisioned} launchVerified=${v.launchVerified} → 实际档位 ${v.mode}`);
    if (v.mode !== "appcontainer") console.log(`[sandbox] 原因：${v.reason}`);
  } catch {
    console.warn("[sandbox] 探针输出不是 JSON：", probeRun.stdout.slice(0, 200));
  }
}