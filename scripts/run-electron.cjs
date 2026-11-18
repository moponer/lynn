#!/usr/bin/env node
/**
 * 用正确的 Electron 运行时启动脚本（2026-11-18 P18-4）。
 *
 * ## 它解决什么问题
 *
 * 如果环境里有 `ELECTRON_RUN_AS_NODE=1`，`electron` 会退化成**纯 Node**：
 * `require("electron").app` 是 undefined，`safeStorage` 拿不到，
 * 飞书凭据解不开（报的是一句和原因无关的
 * "Error while decrypting the ciphertext"）。
 *
 * 这个 DSH 会话里恰好设了那个变量（DSH 自己用 Electron 跑），
 * 所以直接把命令交给用户时**第一次必然失败**。与其让人去查环境变量，
 * 不如在这里删掉它再 spawn。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/run-electron.cjs scripts/feishu-admin.cjs whoami
 * ```
 *
 * `npm run feishu:admin -- whoami` 会转成上面这条。
 */
const { spawn } = require("node:child_process");

/**
 * `require("electron")` 在**纯 node** 下返回二进制的路径字符串；
 * 在 Electron 内部返回 API 对象。我们只要路径，所以必须是纯 node 语境。
 */
const electronPath = require("electron");
if (typeof electronPath !== "string") {
  console.error("✖ 这个包装脚本要在纯 node 下运行（用它自己启动 Electron）");
  process.exit(2);
}

const env = { ...process.env };
// 关键：删掉它，Electron 才会真正以 Electron 身份启动
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
if (!args.length) {
  console.error("用法：node scripts/run-electron.cjs <脚本> [参数…]");
  process.exit(2);
}

const child = spawn(electronPath, args, { env, stdio: "inherit" });
child.on("error", (err) => {
  console.error("✖ 启动 Electron 失败：", err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});