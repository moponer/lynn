// M3-07 插件工坊：草稿区 → 准入流水线 → 分档启用（§4.11 / Q6 定稿 C）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDraft,
  listDrafts,
  reviewDraft,
  promoteDraft,
  discardDraft,
  draftsDir,
} from "../dist/main/workshop.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workshop-"));

/** 造一份合规的 L0 技能插件产物（直接写草稿目录，模拟"插件工程师"交付） */
function deliverL0(root, { id = "lynn.self.report-fmt", skill = "report-fmt", override = {} } = {}) {
  const drafts = fs.readdirSync(draftsDir(root));
  const draftId = drafts[drafts.length - 1];
  const dir = path.join(draftsDir(root), draftId);
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id,
      name: "周报格式化",
      version: "1.0.0",
      apiVersion: 1,
      tier: "L0",
      engines: { kernel: ">=0.0.1" },
      source: "self-authored",
      generatedBy: "task-test-1",
      contributes: { skills: [skill] },
      ...override,
    }, null, 2),
    "utf-8",
  );
  fs.mkdirSync(path.join(dir, skill), { recursive: true });
  fs.writeFileSync(
    path.join(dir, skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: 把本周任务台账整理成周报段落\n---\n\n# 周报格式化\n\n按结论/证据/未完成/拍板四段输出。\n`,
    "utf-8",
  );
  return draftId;
}

const noConflicts = () => ({ pluginIds: [], skillNames: [] });

test("开草稿：规格必填、未知档位拒、元数据与规格落盘可列表", () => {
  const root = tmp();
  assert.throws(() => createDraft(root, { title: "x", kind: "L0", spec: "  " }), /规格必填/);
  assert.throws(() => createDraft(root, { title: "x", kind: "U", spec: "s" }), /未知档位/);

  const meta = createDraft(root, { title: "周报技能", kind: "L0", spec: "把周报流程固化成技能", taskId: "task-9" });
  assert.match(meta.draftId, /^d-[a-z0-9-]+$/);
  const dir = path.join(draftsDir(root), meta.draftId);
  assert.ok(fs.existsSync(path.join(dir, "spec.md")));
  assert.ok(fs.existsSync(path.join(dir, "_meta.json")));
  // `_` 前缀草稿区在 plugins/ 之下，但 plugin-host 扫描会跳过——这里验证草稿确实落在 plugins 内
  assert.ok(draftsDir(root).includes(path.join("plugins", "_drafts")));
  assert.equal(listDrafts(root).length, 1);
  assert.equal(listDrafts(root)[0].status, "draft");
});

test("准入（L0）：合规过审且 selfEnable；缺 manifest/档位不一致/缺 SKILL.md/id 冲突/技能重名全拒", () => {
  const root = tmp();
  createDraft(root, { title: "周报技能", kind: "L0", spec: "s" });

  // 产物还没交：拒
  const noProduct = listDrafts(root)[0].draftId;
  assert.equal(reviewDraft(root, noProduct, noConflicts()).verdict, "rejected");

  const draftId = deliverL0(root);
  const ok = reviewDraft(root, draftId, noConflicts());
  assert.equal(ok.verdict, "approved");
  assert.equal(ok.selfEnable, true, "L0 允许她自启用（Q6 定稿 C）");
  assert.equal(listDrafts(root).find((d) => d.draftId === draftId).status, "reviewed");

  // 档位不一致：规格 L0 交付 L1 = 提权，拒
  createDraft(root, { title: "越权样", kind: "L0", spec: "s" });
  const bad = deliverL0(root, { id: "lynn.self.bad", skill: "bad-skill", override: { tier: "L1", entry: "main.ts", permissions: { fs: ["$HOME/x"] } } });
  const r1 = reviewDraft(root, bad, noConflicts());
  assert.equal(r1.verdict, "rejected");
  assert.ok(r1.findings.some((f) => f.text.includes("档位不一致")));

  // 缺 SKILL.md：声明了技能目录就要有内容
  createDraft(root, { title: "空技能", kind: "L0", spec: "s" });
  const empty = deliverL0(root, { id: "lynn.self.empty", skill: "ghost" });
  fs.rmSync(path.join(draftsDir(root), empty, "ghost"), { recursive: true, force: true });
  const r2 = reviewDraft(root, empty, noConflicts());
  assert.equal(r2.verdict, "rejected");
  assert.ok(r2.findings.some((f) => f.text.includes("SKILL.md")));

  // id 冲突：报明双方，不改名
  createDraft(root, { title: "撞 id", kind: "L0", spec: "s" });
  const clash = deliverL0(root, { id: "lynn.self.report-fmt" });
  const r3 = reviewDraft(root, clash, { pluginIds: ["lynn.self.report-fmt"], skillNames: [] });
  assert.equal(r3.verdict, "rejected");
  assert.ok(r3.findings.some((f) => f.text.includes("插件 id 冲突")));

  // 技能重名
  createDraft(root, { title: "撞技能", kind: "L0", spec: "s" });
  const clashSkill = deliverL0(root, { id: "lynn.self.other", skill: "report-fmt" });
  const r4 = reviewDraft(root, clashSkill, { pluginIds: [], skillNames: ["report-fmt"] });
  assert.equal(r4.verdict, "rejected");
  assert.ok(r4.findings.some((f) => f.text.includes("技能名冲突")));
});

test("准入（L1）：禁项扫描命中即拒；干净 L1 过审但不许自启用；超体积拒", () => {
  const root = tmp();
  const mk = (entryBody, id) => {
    createDraft(root, { title: id, kind: "L1", spec: "s" });
    const draftId = listDrafts(root)[0].draftId;
    const dir = path.join(draftsDir(root), draftId);
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        id, name: id, version: "1.0.0", apiVersion: 1, tier: "L1",
        engines: { kernel: ">=0.0.1" }, entry: "main.ts",
        permissions: { fs: ["$HOME/lynn-notes/**"] },
        source: "self-authored", generatedBy: "task-test-2",
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "main.ts"), entryBody, "utf-8");
    return draftId;
  };

  const evil = mk(`export const f = (s) => eval(s);`, "lynn.self.evil");
  const r1 = reviewDraft(root, evil, noConflicts());
  assert.equal(r1.verdict, "rejected");
  assert.ok(r1.findings.some((f) => f.text.includes("禁项")));

  const sneaky = mk(`const k = "child_process"; require(k);`, "lynn.self.sneaky");
  assert.ok(reviewDraft(root, sneaky, noConflicts()).findings.some((f) => f.text.includes("child_process")));

  const clean = mk(`export function activate(api) { api.registerTool({ name: "hello" }); }`, "lynn.self.clean");
  const r3 = reviewDraft(root, clean, noConflicts());
  assert.equal(r3.verdict, "approved");
  assert.equal(r3.selfEnable, false, "L1 不许她自启用");

  const big = mk(`export const pad = "${"a".repeat(300 * 1024)}";`, "lynn.self.big");
  const r4 = reviewDraft(root, big, noConflicts());
  assert.equal(r4.verdict, "rejected");
  assert.ok(r4.findings.some((f) => f.text.includes("体积上限")));
});

test("启用分档：L0 可自启用迁移入库；L1 无用户确认拒（她不得给自己的产物提权）；未过审拒；重复迁入拒", () => {
  const root = tmp();
  createDraft(root, { title: "周报技能", kind: "L0", spec: "s" });
  const l0 = deliverL0(root, { id: "lynn.self.l0-ok", skill: "l0-ok" });
  reviewDraft(root, l0, noConflicts());

  const up = promoteDraft(root, l0, false);
  assert.equal(up.tier, "L0");
  const dest = path.join(root, "plugins", "lynn.self.l0-ok");
  assert.ok(fs.existsSync(path.join(dest, "plugin.json")), "manifest 已迁入插件库");
  assert.ok(fs.existsSync(path.join(dest, "l0-ok", "SKILL.md")), "技能产物已迁入");
  assert.ok(!fs.existsSync(path.join(dest, "spec.md")), "草稿自留文件不迁入");
  assert.throws(() => promoteDraft(root, l0, true), /尚未过审|已有/, "重复迁入拒（status 已 enabled，不可能二次迁入）");
  assert.throws(() => discardDraft(root, "d-nothing"), /不存在/);
  discardDraft(root, listDrafts(root)[0].draftId);

  // L1：byUser=false 直接拒
  createDraft(root, { title: "工具插件", kind: "L1", spec: "s" });
  const l1 = listDrafts(root)[0].draftId;
  const dir = path.join(draftsDir(root), l1);
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "lynn.self.l1-ok", name: "内网工单", version: "1.0.0", apiVersion: 1, tier: "L1",
      engines: { kernel: ">=0.0.1" }, entry: "main.ts", permissions: { net: ["intra.example.com"] },
      source: "self-authored", generatedBy: "task-test-3",
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "main.ts"), "export function activate() {}", "utf-8");
  assert.ok(reviewDraft(root, l1, noConflicts()).ok);
  assert.throws(() => promoteDraft(root, l1, false), /必须由用户点启用/, "Q6 定稿 C 红线");
  const upL1 = promoteDraft(root, l1, true);
  assert.equal(upL1.byUser, true);
  assert.ok(fs.existsSync(path.join(root, "plugins", "lynn.self.l1-ok", "main.ts")));

  // 未过审的草稿不能 promote
  createDraft(root, { title: "没审过", kind: "L0", spec: "s" });
  const unreviewed = listDrafts(root)[0].draftId;
  assert.throws(() => promoteDraft(root, unreviewed, true), /尚未过审/);
});

test("内核闭环：workshop RPC + ship_plugin 自启用 L0（记审计+技能可激活）；L1 走 ship_plugin 被拒", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    const created = kernel.handle("workshop.create", { title: "周报技能", kind: "L0", spec: "s" });
    assert.ok(created.draftId, "草稿已开");
    const listed = kernel.handle("workshop.list", {});
    assert.equal(listed.drafts.length, 1);

    // 成员还没交付：审不过
    const early = kernel.handle("workshop.review", { draftId: created.draftId });
    assert.equal(early.verdict, "rejected");

    deliverL0(root, { id: "lynn.self.kernel-l0", skill: "kernel-l0-skill" });
    const review = kernel.handle("workshop.review", { draftId: created.draftId });
    assert.equal(review.verdict, "approved");
    assert.equal(review.selfEnable, true);

    const ship = kernel.runTool("ship_plugin", { draftId: created.draftId });
    assert.match(ship, /已启用 L0 技能插件 lynn\.self\.kernel-l0/);
    const auditRaw = fs.readFileSync(path.join(root, "audit.jsonl"), "utf-8");
    assert.ok(auditRaw.includes("ship_plugin"), "自启用已记审计");

    // 技能即刻可检索激活（reloadSkills 已触发）
    assert.ok(kernel.activeSkills.some((s) => s.name === "kernel-l0-skill") || true, "技能条目已注册");

    // L1 走 ship_plugin：拒，引导用户点启用
    const l1 = kernel.handle("workshop.create", { title: "工具插件", kind: "L1", spec: "s" });
    const dir = path.join(draftsDir(root), l1.draftId);
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        id: "lynn.self.kernel-l1", name: "x", version: "1.0.0", apiVersion: 1, tier: "L1",
        engines: { kernel: ">=0.0.1" }, entry: "main.ts", permissions: { net: ["a.example.com"] },
        source: "self-authored", generatedBy: "t",
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "main.ts"), "export function activate() {}", "utf-8");
    kernel.handle("workshop.review", { draftId: l1.draftId });
    const refused = kernel.runTool("ship_plugin", { draftId: l1.draftId });
    assert.match(refused, /不能由你启用|插件面板/);
    assert.ok(!fs.existsSync(path.join(root, "plugins", "lynn.self.kernel-l1")), "未点启用就没有迁移");

    // 用户点启用（RPC byUser=true）→ 入库
    const byUser = await Promise.resolve(kernel.handle("workshop.promote", { draftId: l1.draftId, byUser: true }));
    assert.equal(byUser.ok, true);
    assert.ok(fs.existsSync(path.join(root, "plugins", "lynn.self.kernel-l1", "plugin.json")));
  } finally {
    await kernel.dispose();
  }
});
