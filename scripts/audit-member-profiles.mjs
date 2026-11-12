// 成员档案审计与清洗（2026-11-11）
//   node scripts/audit-member-profiles.mjs           只报告，不改任何文件
//   node scripts/audit-member-profiles.mjs --fix    清洗字段并备份 .bak（保留成员名）
//   LYNN_HOME=<path> 可指定数据根；默认 ~/.lynn
//
// 为什么保留名字：成员名同时是档案文件名、派单匹配键、战绩主键（memberRecord 按名字聚合）
// 与模板匹配词袋。历史档案里的任务化名字（如「shutdown 分析员2」）确实不合规，
// 但自动改名会让旧战绩断链、在跑的工单找不到人。因此清洗只剔除档案正文里的任务信息，
// 名字问题在报告里单列，建议新招募时用通用岗位名（新增入口已有硬闸）。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseMemberProfile, serializeMemberProfile } from "../dist/main/team-store.js";
import {
  validateMemberProfile,
  EXAMPLE_MEMBER_PROFILES,
  MEMBER_WORK_STYLE_BODY,
} from "../dist/main/member-profile.js";

const fix = process.argv.includes("--fix");
const root = process.env.LYNN_HOME || path.join(os.homedir(), ".lynn");
const teamDir = path.join(root, "team");

const [review, inventory, writing] = EXAMPLE_MEMBER_PROFILES;
const verification = {
  name: "验证核验员",
  role: "交付验证与自检专员",
  goal: "对任意给定交付物做可复核的存在性、完整性与一致性核验，如实给出通过或不通过结论",
  boundaries: ["只读，不改动被核验的交付物", "不把未执行的检查写成已通过"],
  deliverable: "一份核验记录：检查项、原始回执、结论与未通过原因",
  evidence: ["检查命令或读取的原始输出", "结论对应的记录"],
  acceptance: ["每个结论都有原始输出支撑", "未通过项逐条写明原因"],
  escalateWhen: "材料拿不到、需要额外权限、或结论无法判定时",
  body: "先确认要核验的对象与判据，再取原始输出；逐项对照，不凭印象下结论；没做的检查如实写没做。",
};
const general = {
  name: "通用执行员",
  role: "只读资料整理与执行专员",
  goal: "按给定简报完成材料核对与结构化整理，交出可复核的结果",
  boundaries: ["不越出授权范围", "不编造未取得的信息"],
  deliverable: "一份结构化结果与证据清单",
  evidence: ["工具原始返回", "核对记录"],
  acceptance: ["结论与证据一一对应", "未完成项如实列出"],
  escalateWhen: "缺材料、需要越权、或目标无法判定时",
  body: MEMBER_WORK_STYLE_BODY,
};

/** 按能力域把历史档案归并到一套标准岗位定义；顺序即优先级。 */
function standardFor(p) {
  const s = `${p.name} ${p.role} ${p.goal}`;
  if (/验证|核验|冒烟|失败路径|读回|交付物|巡检|运行态|测试/.test(s)) return verification;
  if (/审查|走查|核查|分析|阅读|调用链|源码|权限|链路|依赖|配置|shutdown/.test(s)) return review;
  if (/盘点|侦察|统计|清点|提取|组件|资料/.test(s)) return inventory;
  if (/写入|落盘|报告|执笔|方案|文风|文档|撰写|文稿|工坊|插件/.test(s)) return writing;
  return general;
}

function collect() {
  if (!fs.existsSync(teamDir)) return [];
  const files = [];
  for (const team of fs.readdirSync(teamDir)) {
    const dir = path.join(teamDir, team, "members");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      files.push({ team, file: path.join(dir, f), name: f });
    }
  }
  return files;
}

function cleaned(p) {
  const std = standardFor(p);
  return {
    ...p,
    role: std.role,
    goal: std.goal,
    boundaries: [...std.boundaries],
    outputContract: {
      deliverable: std.deliverable,
      evidence: [...std.evidence],
      acceptance: [...std.acceptance],
    },
    escalateWhen: std.escalateWhen,
    body: std.body,
  };
}

const files = collect();
let dirty = 0;
let totalIssues = 0;
let nonNameIssues = 0;
const badNames = [];
const fixed = [];
const skipped = [];

for (const item of files) {
  let p;
  try {
    p = parseMemberProfile(fs.readFileSync(item.file, "utf-8"));
  } catch (err) {
    skipped.push(`${item.team}/${item.name}: 解析失败 ${err.message}`);
    continue;
  }
  const issues = validateMemberProfile(p);
  if (!issues.length) continue;
  dirty += 1;
  totalIssues += issues.length;
  nonNameIssues += issues.filter((i) => i.field !== "name").length;
  const nameIssues = issues.filter((i) => i.field === "name");
  if (nameIssues.length) badNames.push(`${item.team}/${item.name} → ${nameIssues.map((i) => i.rule).join("、")}`);
  if (!fix) {
    console.log(`--- ${item.team}/${item.name}`);
    for (const i of issues) console.log(`    ${i.field}: ${i.rule} → 「${i.snippet}」`);
    continue;
  }
  const next = cleaned(p);
  const remaining = validateMemberProfile(next, { skipName: true });
  if (remaining.length) {
    skipped.push(`${item.team}/${item.name}: 清洗后仍不合规，未写入（${remaining.map((i) => i.rule).join("、")}）`);
    continue;
  }
  const bak = `${item.file}.bak`;
  if (!fs.existsSync(bak)) fs.copyFileSync(item.file, bak);
  fs.writeFileSync(item.file, serializeMemberProfile(next), "utf-8");
  fixed.push(`${item.team}/${item.name} → 标准岗位「${standardFor(p).name}」`);
}

console.log(`\n数据根：${root}`);
console.log(`档案 ${files.length} 份；含任务信息 ${dirty} 份；命中 ${totalIssues} 处。`);
if (badNames.length) {
  console.log(`\n名字不合规（保留以免断战绩链，新增入口已硬拒）${badNames.length} 份：`);
  for (const n of badNames) console.log(`  - ${n}`);
}
if (fix) {
  console.log(`\n已清洗 ${fixed.length} 份（原文件备份为 .bak）：`);
  for (const f of fixed) console.log(`  - ${f}`);
}
for (const s of skipped) console.log(`跳过：${s}`);
if (!fix && dirty) {
  console.log(
    nonNameIssues
      ? "\n要清洗字段：node scripts/audit-member-profiles.mjs --fix"
      : "\n字段已全部合规；剩余仅为历史成员名，按设计保留（新增入口已硬拒，不会自动改名）。",
  );
}
// CI 用法：--check 只报告，有字段级违规就退出非 0；历史名字不算失败。
if (process.argv.includes("--check") && nonNameIssues) process.exitCode = 1;

// 编制模板是「跨任务重复雇佣」的主路径：模板里的档案同样不能带上一单的任务信息。
function auditTemplates() {
  const dir = path.join(teamDir, "_templates");
  if (!fs.existsSync(dir)) return;
  let count = 0;
  let dirtyCount = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const file = path.join(dir, f);
    let tpl;
    try {
      tpl = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(tpl.members)) continue;
    count += 1;
    const hits = tpl.members.reduce((n, m) => n + validateMemberProfile(m, { skipName: true }).length, 0);
    if (!hits) continue;
    dirtyCount += 1;
    console.log(`\n编制模板 ${f}：${tpl.members.length} 人，命中 ${hits} 处任务信息`);
    if (!fix) continue;
    const next = { ...tpl, members: tpl.members.map(cleaned) };
    const remaining = next.members.reduce((n, m) => n + validateMemberProfile(m, { skipName: true }).length, 0);
    if (remaining) {
      console.log(`  清洗后仍有 ${remaining} 处，未写入`);
      continue;
    }
    const bak = `${file}.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    console.log(`  已清洗（备份 ${path.basename(bak)}）`);
  }
  if (count) console.log(`\n编制模板 ${count} 套，含任务信息 ${dirtyCount} 套。`);
}
auditTemplates();
