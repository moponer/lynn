// 壳层防漂移（不 import shell-rpc，避免连带 electron）+ openPathBlockReason 行为断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openPathBlockReason } from "../dist/main/path-guard.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const shellSource = fs.readFileSync(path.join(projectRoot, "src/main/shell-rpc.ts"), "utf-8");
const contractSource = fs.readFileSync(path.join(projectRoot, "src/shared/contract.ts"), "utf-8");

function block(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到代码块起点：${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `找不到代码块终点：${to}`);
  return source.slice(start, end);
}

test("evidence.open 与 app.openPath 共用扩展名白名单，并保留 realpath 复查", () => {
  const evidence = block(shellSource, 'rpc("evidence.open"', 'rpc("app.resolveRef"');
  assert.match(evidence, /openPathBlockReason\(openBase, r\.target\)/);
  assert.match(evidence, /insideBase\(taskBase, r\.target\)/);
  assert.match(evidence, /path\.dirname\(r\.target\)/, "目录外已登记交付物只复查其自身 containment");
});

test("office 预览走 IPC TypedArray：不回到自定义协议，也不回 base64", () => {
  // 2026-11-15 实测：file:// 页面 fetch 自定义 scheme 会被 Chromium 的 CORS 硬拦
  // （Failed to fetch），这条路走不通；base64 又膨胀 33%。锁定 dataBytes 通道。
  const branch = block(shellSource, 'if (ext === "docx"', "const LIMIT = 600_000");
  assert.match(branch, /dataBytes: new Uint8Array\(buf\)/);
  assert.doesNotMatch(branch, /assetUrl|dataBase64|lynn-asset/);
});

test("pet.open 暂时停用且不创建窗口；pet.close/focus 行为不变，契约允许错误返回", () => {
  const open = block(shellSource, 'rpc("pet.open"', 'rpc("pet.close"');
  assert.match(open, /ok:\s*false,\s*error:\s*"桌宠功能暂时停用"/);
  assert.doesNotMatch(open, /createPet/);
  assert.match(block(shellSource, 'rpc("pet.close"', 'rpc("pet.focus"'), /ctx\.closePet\(\)/);
  assert.match(block(shellSource, 'rpc("pet.focus"', 'rpc("window.control"'), /ctx\.focusMain\(\)/);
  assert.match(contractSource, /"pet\.open":\s*\{\s*params:\s*void;\s*result:\s*\{\s*ok:\s*boolean;\s*error\?:\s*string\s*\}\s*\}/);
});

test("打开策略：文档与目录放行，脚本/可执行文件拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-open-"));
  fs.writeFileSync(path.join(root, "report.md"), "ok");
  fs.writeFileSync(path.join(root, "run.bat"), "echo no");
  fs.writeFileSync(path.join(root, "run.exe"), "no");
  assert.equal(openPathBlockReason(root, path.join(root, "report.md")), null);
  assert.equal(openPathBlockReason(root, root), null);
  assert.match(openPathBlockReason(root, path.join(root, "run.bat")), /白名单/);
  assert.match(openPathBlockReason(root, path.join(root, "run.exe")), /白名单/);
});

test("证据链接指向根外时，即使扩展名合规也不能打开", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-evidence-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-outside-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  const link = path.join(root, "evidence.md");
  try {
    fs.symlinkSync(path.join(outside, "secret.md"), link);
  } catch (err) {
    t.skip(`当前环境无权创建文件符号链接：${String(err)}`);
    return;
  }
  assert.match(openPathBlockReason(root, link), /数据目录/);
});
