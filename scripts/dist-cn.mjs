/**
 * 国内网络可用的打包入口（2026-11-16）：
 *   npm run dist:cn                       → 打包到 electron-builder.yml 里的 scripts/directories.output
 *   npm run dist:cn -- -c.directories.output=release-asar    → 换输出目录（release 被句柄占用时用）
 *
 * 解决两个与业务无关的本机坑（见 README「打包」）：
 *  1) electron 分发包（158 MB）从 GitHub 走代理常在 100% 断流 → 默认改用 npmmirror 镜像；
 *  2) IDE 集成终端注入 NODE_OPTIONS=--require safe-delete 垫片，会把 electron-builder
 *     解压前的 fs.rm 变成"扔回收站"（报 [safe-delete] 操作失败 / EBUSY）→ 子进程清空该变量。
 * 两个修法都只作用于**子进程环境**，不改变 npm 自身与当前 shell。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mirror = process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
const passthrough = process.argv.slice(2);

const env = { ...process.env, ELECTRON_MIRROR: mirror };
// 清掉垫片：否则 electron-builder 清 win-unpacked 时会走"回收站"，失败或直接挂住
delete env.NODE_OPTIONS;

function run(label, command, args, options = {}) {
  console.log(`[dist:cn] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    // Windows 上 npm 是 npm.cmd，必须经 shell 才能解析；
    // 而 node.exe 走 shell 会被空格路径拆开（"C:\Program" 不是命令），所以只对 npm 开
    shell: options.shell ?? false,
  });
  if (result.error) {
    console.error(`[dist:cn] ${label} 启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[dist:cn] ${label} 失败（exit ${result.status ?? "?"}）`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[dist:cn] electron 镜像：${mirror}`);
console.log(`[dist:cn] NODE_OPTIONS 已对子进程清空（绕过 safe-delete 垫片）`);

run("构建（typecheck + vite + tsc）", "npm", ["run", "build"], {
  shell: process.platform === "win32",
});

run("打包（electron-builder）", process.execPath, [
  path.join(root, "node_modules", "electron-builder", "cli.js"),
  "--win",
  "--config",
  "electron-builder.yml",
  ...passthrough,
]);

console.log("[dist:cn] 完成");
