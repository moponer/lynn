import path from "node:path";

/**
 * asar 里 ↔ 真实磁盘上的路径转换（2026-11-16 开启 asar 打包时引入）。
 *
 * 为什么需要它：主进程的 fs 有 asar 补丁，`fs.existsSync("…/app.asar/agent/x.mjs")`
 * 是成立的；但**交给子进程的脚本路径**必须是真实文件——我们起的 Pi worker 与 L1 worker
 * 用的是 `process.execPath + ELECTRON_RUN_AS_NODE=1`，那种进程**没有** asar 补丁，
 * `app.asar` 里的路径对它根本不存在（表现为 Cannot find module / 进程秒退）。
 * electron-builder 的 `asarUnpack` 会把指定目录**同时**放在 `app.asar.unpacked` 下，
 * 所以这里只要把路径里的 `app.asar` 段换成 `app.asar.unpacked` 即可。
 *
 * 开发态（`npm start`）路径里没有 `app.asar` 段，原样返回，行为不变。
 */
export function unpackedPath<T extends string | undefined>(p: T): T {
  if (typeof p !== "string" || !p) return p;
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!p.includes(marker)) return p;
  return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) as T;
}
