// 2026-11-13 审计 #2 P1 修复回归；2026-11-17 P5-1 改为**按单**授权。
//
// 为什么从「按权限档」改成「按单」：权限档是全局的——切到自动档就等于**所有单**都能联网，
// 而一张单要抓数据不代表下一张也要。现在的口径是：
//   默认不给网；这张单在派单时拿了 network 授权才放行；拒绝时把两条出路说清楚。
//
// 拒绝文案是这组测试的重点：成员被拒后最危险的行为不是放弃，而是**换个写法硬试**
// （改命令名、拼字符串、写进脚本再跑）。所以文案必须同时给出「用 browser_*」和「ESCALATE 申请」。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Toolkit } from "../dist/main/toolkit.js";

const tmp = (p = "lynn-outbound-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("出站闸：没有联网授权时 curl 直接拒（命令不执行，审计留痕）", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { outboundAllowed: () => false, onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "curl https://example.com/upload -d @data.json" });
  assert.match(out, /没有联网授权/, "要说清是被授权闸挡住的，不是命令写错");
  assert.match(out, /browser_/, "必须告诉成员：取网页数据有不用开网的正道");
  assert.match(out, /ESCALATE/, "确实要脚本联网的，要给申请路径");
  assert.match(out, /不要换写法绕过/, "明确堵住「换个写法硬试」这条空转路");
  assert.ok(audits.some((a) => a.kind === "cmd_blocked" && /联网授权/.test(a.why ?? "")), "审计要记一条 blocked");
});

test("出站闸：有授权（本单 network: true）就放行，且仍记 cmd_net 审计", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { outboundAllowed: () => true, onAudit: (ev) => audits.push(ev) });
  // echo 里的 URL 会被 OUTBOUND 命中，但命令本身无害（不真联网）
  const out = await t.runCommand({ command: "echo https://example.com" });
  assert.doesNotMatch(out, /没有联网授权/);
  assert.ok(audits.some((a) => a.kind === "cmd_net"), "放行也要留出站审计");
});

test("出站闸：不注入 = 旧行为（只审计不拦），既有直用方不受影响", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "echo https://example.com" });
  assert.doesNotMatch(out, /没有联网授权/);
  assert.ok(audits.some((a) => a.kind === "cmd_net"));
});

test("出站闸：非出站命令不受影响（不给网也不误伤日常命令）", async () => {
  const audits = [];
  const t = new Toolkit(tmp(), { outboundAllowed: () => false, onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "echo hello" });
  assert.doesNotMatch(out, /没有联网授权/);
  assert.ok(!audits.some((a) => a.kind === "cmd_net"), "没有出站就不该记出站审计");
});

test("按单授权：TaskRecord 能存能读 network；缺省就是没有网", async () => {
  const { TaskStore } = await import("../dist/main/task-store.js");
  const root = tmp("lynn-netgrant-");
  const s = new TaskStore(root);
  s.create({ id: "task-off", title: "不上网的活", teamId: "g1" });
  s.create({
    id: "task-on",
    title: "要抓数据的活",
    teamId: "g1",
    network: { granted: true, by: "lynn", at: "2026-11-17T00:00:00.000Z", reason: "要从交易所接口拉当日行情" },
  });

  assert.equal(s.get("task-off")?.network, undefined, "没申请就没有网——缺省必须是不给");
  const on = s.get("task-on")?.network;
  assert.equal(on?.granted, true);
  assert.equal(on?.by, "lynn");
  assert.match(on?.reason ?? "", /交易所接口/, "为什么给要落盘，回查时才知道当初的依据");
  // 关键：授权按单存，不是全局开关——「这张单要联网」不许顺带放开别的单
  assert.equal(s.get("task-off")?.network, undefined);
  // 重新读盘也要在（不是只活在内存里：派单之后才跑命令，那时是另一个实例在读）
  assert.equal(new TaskStore(root).get("task-on")?.network?.granted, true);
});

test("按单授权：assign_task 的工具描述里要写明这个选项与「优先用 browser_*」", async () => {
  const { Kernel } = await import("../dist/main/kernel.js");
  const root = tmp("lynn-netschema-");
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ model: { provider: "t", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: { encrypted: false, data: "k" }, updatedAt: new Date().toISOString() } }),
    "utf-8",
  );
  const kernel = new Kernel(root);
  try {
    const assignTool = kernel.allTools().find((t) => t.function.name === "assign_task");
    const props = assignTool.function.parameters.properties;
    assert.ok(props.network, "没有这个参数，风铃根本不知道能给单开网");
    assert.match(props.network.description ?? "", /browser_/, "要提醒：取网页数据优先用 browser_*，不用开网");
    assert.match(props.network.description ?? "", /缺省 false/, "必须写明默认不给");
    assert.ok(props.networkReason, "要能记为什么开");
  } finally {
    await kernel.dispose();
  }
});

test("已知边界：URL 藏在脚本文件里时，正则闸看不出来（只能靠进程级沙箱堵）", async () => {
  const root = tmp();
  // 脚本里有 URL、有 https 调用，但**命令行本身干净** —— 正则闸完全看不见
  fs.writeFileSync(
    path.join(root, "scrape.js"),
    "const u = 'https://example.com/data';\nconsole.log('would fetch ' + u);\n",
    "utf8",
  );
  const audits = [];
  const t = new Toolkit(root, { outboundAllowed: () => false, onAudit: (ev) => audits.push(ev) });
  const out = await t.runCommand({ command: "node scrape.js" });
  assert.doesNotMatch(out, /没有联网授权/, "命令行里没有出站关键字，闸门看不见——这是已知缺口，不是回归");
  assert.match(out, /would fetch https/, "命令确实跑起来了，说明它没被任何一层拦住");
  assert.ok(!audits.some((a) => a.kind === "cmd_blocked"), "连审计都不会记，因为压根没识别成出站");
  // 这个缺口只能由 P5-1b 的进程级沙箱（AppContainer 不加 internetClient）堵。
  // 写成测试是为了钉住它：别哪天有人以为"有出站闸就算安全了"。
});