// RPC 契约与实现的对齐检查（2026-11-14）。
//
// 背景：`contract.ts` 的 RpcContracts 是手写名单，实现散在 kernel.handle 的巨型 switch
// 与 shell-rpc 的注册表里，编译器不保证三者一致。历史上出过两次事故：
//   - 往 switch 插 case 时误删 `task.detail` → 前端拿到 unknown rpc；
//   - 新增契约后忘了加 case → 只有点到那条路径才炸。
// 这个测试直接读三份源码做双向差集，纯文本正则，不依赖构建产物。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/** 只取 `interface RpcContracts { ... }` 这一段，避免把别的类型表算进来 */
function contractSection(src) {
  const start = src.indexOf("export interface RpcContracts {");
  assert.ok(start >= 0, "找不到 RpcContracts");
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let p = i; p < src.length; p += 1) {
    if (src[p] === "{") depth += 1;
    else if (src[p] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(i, p + 1);
    }
  }
  throw new Error("RpcContracts 没有闭合");
}

const KEY = String.raw`"([a-z0-9]+(?:\.[a-zA-Z0-9]+)+)"`;

function contractKeys() {
  const body = contractSection(read("src/shared/contract.ts"));
  return [...body.matchAll(new RegExp(String.raw`^\s{2}${KEY}\s*:\s*\{`, "gm"))].map((m) => m[1]);
}

function kernelCases() {
  const src = read("src/main/kernel.ts");
  const cases = [...src.matchAll(new RegExp(String.raw`^\s+case\s+${KEY}\s*:`, "gm"))].map((m) => m[1]);
  // 新增：匹配 kernel.ts 中的 registry.register() 调用（kernel 拆域后，部分方法从 switch 迁移到注册表）
  const registryCalls = [...src.matchAll(new RegExp(String.raw`registry\.register\(\s*${KEY}`, "g"))].map((m) => m[1]);
  return [...new Set([...cases, ...registryCalls])];
}

/** rpc-registry.ts 里的注册调用（kernel 拆域第一批：model.* 方法） */
function registryCases() {
  const src = read("src/main/rpc-registry.ts");
  return [...src.matchAll(new RegExp(String.raw`registry\.register\(\s*${KEY}`, "g"))].map((m) => m[1]);
}

function shellHandlers() {
  const src = read("src/main/shell-rpc.ts");
  const keys = [
    ...src.matchAll(new RegExp(String.raw`\brpc\(\s*${KEY}`, "g")),
    ...src.matchAll(new RegExp(String.raw`\bregistry\.set\(\s*${KEY}`, "g")),
  ].map((m) => m[1]);
  // 内核异步面（要真发 HTTP，走 KERNEL_ASYNC_METHODS 白名单而不是 rpc()）
  const at = src.indexOf("KERNEL_ASYNC_METHODS");
  if (at >= 0) {
    const arr = src.slice(at, src.indexOf("]", at) + 1);
    keys.push(...[...arr.matchAll(new RegExp(KEY, "g"))].map((m) => m[1]));
  }
  return keys;
}

/** main.ts 里还有两处 if 链（update.* 与消息平台），也是正式实现点 */
function mainHandlers() {
  const src = read("src/main/main.ts");
  return [...src.matchAll(new RegExp(String.raw`method\s*===\s*${KEY}`, "g"))].map((m) => m[1]);
}

const allImplemented = () => [...kernelCases(), ...registryCases(), ...shellHandlers(), ...mainHandlers()];
const uniq = (xs) => [...new Set(xs)].sort();

test("契约里声明的每个 RPC 都有实现（kernel / 壳层注册表 / main 的 if 链）", () => {
  const declared = uniq(contractKeys());
  const implemented = new Set(allImplemented());
  const missing = declared.filter((k) => !implemented.has(k));
  assert.deepEqual(missing, [], `契约里有、但没人接的方法：${missing.join(", ")}`);
});

test("实现里挂的每个 RPC 都在契约里（防拼错 / 防删类型不删 case）", () => {
  const declared = new Set(contractKeys());
  const extra = uniq(allImplemented()).filter((k) => !declared.has(k));
  assert.deepEqual(extra, [], `实现了、但契约里没有的方法（会退化成 any）：${extra.join(", ")}`);
});

test("三份名单都不是空的（正则没写崩）", () => {
  assert.ok(contractKeys().length > 50, "契约 key 数量异常少");
  assert.ok(kernelCases().length > 50, "kernel case 数量异常少");
  assert.ok(shellHandlers().length > 5, "壳层 handler 数量异常少");
});
