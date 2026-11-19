// 命令输出（2026-11-14）：GBK 解码 + 头尾保留（报错在尾部，旧实现会丢掉）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as iconv from "iconv-lite";
import { decodeCommandOutput, shapeCommandOutput, formatCommandResult } from "../dist/main/cmd-output.js";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cout-"));

test("解码：UTF-8 原样；GBK 字节能正确还原；空输入空输出", () => {
  assert.equal(decodeCommandOutput(Buffer.from("正常输出", "utf8")), "正常输出");
  assert.equal(decodeCommandOutput(iconv.encode("中文报错：找不到文件", "gbk")), "中文报错：找不到文件");
  assert.equal(decodeCommandOutput(undefined), "");
  assert.equal(decodeCommandOutput(Buffer.alloc(0)), "");
});

test("整形：超预算保留头尾，并写明中间省略了多少", () => {
  const text = `${"头".repeat(500)}${"中".repeat(3000)}${"尾".repeat(500)}`;
  const out = shapeCommandOutput(text, 400);
  assert.match(out, /中间省略/);
  assert.ok(out.startsWith("头"), "头部要在");
  assert.ok(out.trimEnd().endsWith("尾"), "尾部要在");
  assert.equal(shapeCommandOutput("短", 400), "短", "不超预算原样返回");
});

test("拼接：stdout / stderr 分开，exit code 如实", () => {
  const text = formatCommandResult({
    stdout: Buffer.from("ok\n"),
    stderr: Buffer.from("boom\n"),
    exitCode: 2,
    budget: 1000,
  });
  assert.match(text, /stdout:\nok/);
  assert.match(text, /stderr:\nboom/);
  assert.match(text, /exit code: 2/);
  assert.equal(formatCommandResult({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0, budget: 1000 }), "exit code: 0");
});

test("集成：大输出 + 非零退出，超长部分落盘（数据不丢），stderr 仍留在结果里", async () => {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, "emit.js"),
    "process.stdout.write('x'.repeat(5000)); process.stderr.write('TAIL_ERROR_MARK'); process.exit(3);",
  );
  const tk = new Toolkit(root, { outputCap: 300 });
  const out = await tk.execute("run_command", { command: "node emit.js" });
  // stderr 未超 300，原样保留
  assert.match(out, /TAIL_ERROR_MARK/, "stderr 必须保住");
  assert.match(out, /exit code: 3/);
  // stdout 超 300 → 落盘，结果里给路径（2026-11-19：不再只头尾截断丢数据）
  const spillMatch = out.match(/_tool-output\/stdout-[^\]]+\.txt/);
  assert.ok(spillMatch, `超长 stdout 应落盘并给路径，实际：${out.slice(0, 120)}`);
  // 落盘文件里是完整 5000 字符
  const spilled = fs.readFileSync(path.join(root, spillMatch[0].replace(/\//g, path.sep)), "utf-8");
  assert.equal(spilled.length, 5000, "落盘文件必须是完整原文，不丢数据");
});

test("集成：超预算但没给 spill 时，退回头尾各留一半（不丢执行）", () => {
  const big = "A".repeat(3000) + "ERR_TAIL";
  const out = formatCommandResult({ stdout: Buffer.from(big), stderr: Buffer.from(""), exitCode: 1, budget: 200 });
  assert.match(out, /中间省略/, "没有落盘通道时退回旧的头尾截断");
  assert.match(out, /ERR_TAIL/, "尾部要保留");
});
