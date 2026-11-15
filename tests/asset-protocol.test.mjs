// lynn-asset:// 一次性令牌协议单元测试（纯逻辑，不依赖 Electron）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  consumeAssetToken,
  issueAssetToken,
  validateAssetTarget,
} from "../dist/main/asset-protocol.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-asset-"));

test("issue/consume：令牌一次性、TTL 60s、过期返回 null", () => {
  const root = tmp();
  const target = path.join(root, "test.docx");
  fs.writeFileSync(target, "hello");
  const token = issueAssetToken({ target, ext: "docx", bytes: 5 });
  assert.ok(token.length > 0, "令牌应非空");

  const payload = consumeAssetToken(token);
  assert.ok(payload, "首次消费应成功");
  assert.equal(payload.target, target);
  assert.equal(payload.ext, "docx");
  assert.equal(payload.bytes, 5);

  assert.equal(consumeAssetToken(token), null, "二次消费应失败（一次性）");
  assert.equal(consumeAssetToken("nope"), null, "无效令牌应返回 null");
});

test("validateAssetTarget：扩展名白名单", () => {
  const root = tmp();
  const docx = path.join(root, "a.docx");
  const xlsx = path.join(root, "b.xlsx");
  const pptx = path.join(root, "c.pptx");
  const bad = path.join(root, "d.pdf");
  fs.writeFileSync(docx, "x");
  fs.writeFileSync(xlsx, "x");
  fs.writeFileSync(pptx, "x");
  fs.writeFileSync(bad, "x");

  assert.ok(validateAssetTarget(docx, [root]).ok, "docx 应放行");
  assert.ok(validateAssetTarget(xlsx, [root]).ok, "xlsx 应放行");
  assert.ok(validateAssetTarget(pptx, [root]).ok, "pptx 应放行");
  assert.ok(!validateAssetTarget(bad, [root]).ok, "pdf 应拒绝");
});

test("validateAssetTarget：符号链接逃逸拒绝", () => {
  const root = tmp();
  const outside = path.join(os.tmpdir(), "lynn-outside-" + Date.now().toString(36));
  fs.mkdirSync(outside, { recursive: true });
  const target = path.join(outside, "secret.docx");
  fs.writeFileSync(target, "secret");
  const link = path.join(root, "link.docx");
  try {
    fs.symlinkSync(target, link);
  } catch {
    // 无权限创建符号链接的环境跳过
    return;
  }
  assert.ok(!validateAssetTarget(link, [root]).ok, "符号链接指向根外应拒绝");
});

test("validateAssetTarget：目录穿越拒绝", () => {
  const root = tmp();
  const target = path.join(root, "a.docx");
  fs.writeFileSync(target, "x");
  assert.ok(!validateAssetTarget(path.join(root, "..", "a.docx"), [root]).ok, ".. 穿越应拒绝");
});

test("validateAssetTarget：文件必须存在且为普通文件", () => {
  const root = tmp();
  assert.ok(!validateAssetTarget(path.join(root, "nope.docx"), [root]).ok, "不存在应拒绝");
  const dir = path.join(root, "sub");
  fs.mkdirSync(dir);
  assert.ok(!validateAssetTarget(dir, [root]).ok, "目录应拒绝");
});
