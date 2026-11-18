/**
 * ACI 符号四件套（P4-1 / 10 章 §3）。
 *
 * 这项要解决的问题很具体：成员定位代码只会"整篇读 + grep 猜"，一份 1,763 行的文件
 * 找入口要读好几遍（10 章 §9：15 次 read_file/任务）。符号工具的价值不在"更快的读"，
 * 而在**先知道文件里有什么**——所以测试要证明的是：
 *  1. 扫描能认出各语言的顶层声明，并且**范围算对**（endLine 不是拍脑袋给的）；
 *  2. read_symbol 只回那一段，不回整篇（这才是省下读次数的机制）；
 *  3. find_references 按词边界匹配（`getUser` 不许命中 `getUserById`——那会夸大改名的风险面）；
 *  4. 认不出时如实降级（词法扫描不是语法树），不许让成员以为"文件里没有"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSymbols, matchSymbols, langOf, isScannable } from "../dist/main/symbols.js";
import { Toolkit } from "../dist/main/toolkit.js";

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-aci-"));
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf8");
  return full;
}

const TS_SAMPLE = `import { x } from "y";

export function alpha(a: number) {
  if (a > 0) {
    return a;
  }
  return 0;
}

export class Beta {
  run() {
    return 1;
  }
}

const gamma = () => 3;

interface Delta {
  a: string;
}
`;

test("scanSymbols：TS 顶层声明与范围", () => {
  const syms = scanSymbols(TS_SAMPLE, "ts");
  const names = syms.map((s) => s.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("Beta"));
  assert.ok(names.includes("gamma"));
  assert.ok(names.includes("Delta"));
  const alpha = syms.find((s) => s.name === "alpha");
  assert.equal(alpha.kind, "function");
  assert.equal(alpha.line, 3);
  // alpha 的函数体从第 3 行到第 8 行的 "}"，范围必须覆盖整个函数体
  assert.equal(alpha.endLine, 8, `alpha 的范围算错了：${alpha.line}-${alpha.endLine}`);
  const beta = syms.find((s) => s.name === "Beta");
  assert.equal(beta.kind, "class");
  assert.equal(beta.endLine, 14, "类的范围要包住方法体里的花括号（嵌套配对）");
});

test("scanSymbols：Python 靠缩进算范围，缩进回到顶格就结束", () => {
  const py = [
    "import os",
    "",
    "def outer(a):",
    "    if a:",
    "        return 1",
    "    return 0",
    "",
    "class Thing:",
    "    def method(self):",
    "        return 2",
    "",
  ].join("\n");
  const syms = scanSymbols(py, "py");
  const outer = syms.find((s) => s.name === "outer");
  assert.equal(outer.line, 3);
  assert.equal(outer.endLine, 6, `outer 的范围 ${outer.line}-${outer.endLine} 不对`);
  const cls = syms.find((s) => s.name === "Thing");
  assert.equal(cls.kind, "class");
});

test("scanSymbols：Rust / Go 的声明形状", () => {
  const rs = "pub fn run() {\n    1\n}\n\npub struct S {\n    a: u8,\n}\n\nimpl S {\n    fn m(&self) {}\n}\n";
  const rsSyms = scanSymbols(rs, "rs");
  assert.deepEqual(
    rsSyms.map((s) => `${s.kind}:${s.name}`),
    ["function:run", "struct:S", "impl:S"],
    "impl 也要能认出来（改 trait 实现时要知道有哪些）",
  );

  const go = "package main\n\nfunc Handle(a int) error {\n\treturn nil\n}\n\ntype Req struct {\n\tA int\n}\n";
  const goSyms = scanSymbols(go, "go");
  assert.deepEqual(
    goSyms.map((s) => `${s.kind}:${s.name}`),
    ["function:Handle", "struct:Req"],
  );
});

test("scanSymbols：注释行与嵌套局部函数不算顶层符号", () => {
  const code = ["// function fake() {}", "# def fake():", "function real() {", "  function inner() {}", "}"].join("\n");
  const syms = scanSymbols(code, "ts");
  assert.deepEqual(syms.map((s) => s.name), ["real"], "注释里的声明与函数体里的局部函数都不该算顶层");
});

test("matchSymbols：完全相等 > 前缀 > 子串", () => {
  const syms = [
    { name: "getUserById", kind: "function", line: 1, endLine: 1, exported: true, signature: "" },
    { name: "getUser", kind: "function", line: 2, endLine: 2, exported: true, signature: "" },
    { name: "user", kind: "const", line: 3, endLine: 3, exported: true, signature: "" },
  ];
  assert.deepEqual(matchSymbols(syms, "getUser").map((s) => s.name), ["getUser", "getUserById"]);
  assert.deepEqual(matchSymbols(syms, "user").map((s) => s.name), ["user", "getUser", "getUserById"]);
});

test("langOf / isScannable：只对五种语言开符号能力，二进制与超大文件跳过", () => {
  assert.equal(langOf("a.ts"), "ts");
  assert.equal(langOf("a.py"), "py");
  assert.equal(langOf("a.rs"), "rs");
  assert.equal(langOf("a.go"), "go");
  assert.equal(langOf("a.docx"), "unknown");
  assert.equal(isScannable("a.ts", 100), true);
  assert.equal(isScannable("a.ts", 3_000_000), false, "超大文件不扫，别把主进程卡死");
  assert.equal(isScannable("a.md", 100), false);
});

// ---------- 工具层 ----------

test("repo_map：给出文件 + 顶层符号 + 行号，并标注是词法扫描", () => {
  const ws = tmpWs();
  write(ws, "src/a.ts", TS_SAMPLE);
  write(ws, "src/deep/b.py", "def hi():\n    return 1\n");
  write(ws, "README.md", "# 不是代码\n");
  const k = new Toolkit(ws);
  return k.execute("repo_map", { depth: 3 }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "repo_map");
    assert.match(r.precision, /词法扫描/, "必须如实标注不是语法树");
    assert.match(r.map, /src\/a\.ts/);
    assert.match(r.map, /alpha/);
    assert.ok(!r.map.includes("README.md"), "只列代码文件");
    assert.match(r.next, /read_symbol|更窄的 path/, "回执要带下一步");
  });
});

test("read_symbol：只回那一段，不回整篇（这就是省读次数的机制）", () => {
  const ws = tmpWs();
  const filler = Array.from({ length: 300 }, (_, i) => `// 填充 ${i}`).join("\n");
  write(ws, "big.ts", `${filler}\n\nexport function target() {\n  return 42;\n}\n${filler}\n`);
  const k = new Toolkit(ws);
  return k.execute("read_symbol", { file: "big.ts", symbol: "target" }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, true);
    assert.match(r.summary, /302-304 行/, "要给准确范围（行号是真实行号，不是符号在符号表里的序号）");
    assert.match(r.body, /return 42/);
    assert.ok(r.body.length < 200, `只该回目标函数，实际回了 ${r.body.length} 字符`);
    assert.ok(!r.body.includes("填充"), "不该把整篇文件带回来");
  });
});

test("read_symbol：找不到符号时明确降级建议，不许让人以为文件里没有", () => {
  const ws = tmpWs();
  write(ws, "a.ts", TS_SAMPLE);
  const k = new Toolkit(ws);
  return k.execute("read_symbol", { file: "a.ts", symbol: "不存在的符号" }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, false);
    assert.match(r.next, /grep/, "要提示词法扫描可能漏，给 grep 兜底");
    assert.match(r.next, /read_file/, "也给分段读的退路");
  });
});

test("find_symbol：跨文件找同名定义", () => {
  const ws = tmpWs();
  write(ws, "a.ts", TS_SAMPLE);
  write(ws, "b/c.ts", "export function alpha2() {}\n");
  const k = new Toolkit(ws);
  return k.execute("find_symbol", { query: "alpha" }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, true);
    assert.equal(r.hits.length, 2);
    assert.ok(r.hits.some((h) => h.includes("src/a.ts") || h.includes("a.ts")));
    assert.ok(r.hits.some((h) => h.includes("alpha2")), "部分匹配也要能找到");
  });
});

test("find_references：按词边界匹配，getUser 不许命中 getUserById", () => {
  const ws = tmpWs();
  write(
    ws,
    "a.ts",
    [
      "function getUser() { return 1; }",
      "function getUserById() { return 2; }",
      "const x = getUser();",
      "const y = getUserById();",
    ].join("\n"),
  );
  const k = new Toolkit(ws);
  return k.execute("find_references", { symbol: "getUser" }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, true);
    const refs = r.hits.filter((h) => !h.includes("[定义]"));
    assert.equal(refs.length, 1, `只该命中一次调用，实际：${JSON.stringify(refs)}`);
    assert.ok(r.hits.some((h) => h.includes("[定义]")), "定义处要标出来，不然看不出改哪");
    assert.ok(!r.hits.some((h) => h.includes("getUserById")), "词边界没生效，风险面被夸大了");
  });
});

test("find_references：多处定义会提醒「先确认改哪一处」", () => {
  const ws = tmpWs();
  write(ws, "a.ts", "export function dup() {}\n");
  write(ws, "b.ts", "export function dup() {}\n");
  const k = new Toolkit(ws);
  return k.execute("find_references", { symbol: "dup" }).then((raw) => {
    const r = JSON.parse(raw);
    assert.equal(r.ok, true);
    assert.match(r.next, /不止一处定义/);
  });
});

test("符号工具进得了成员工具面：白名单里有，schema 也发得下来", async () => {
  const { MEMBER_EXEC_TOOLS, memberToolSchemas } = await import("../dist/main/member-runner.js");
  for (const name of ["repo_map", "find_symbol", "read_symbol", "find_references"]) {
    assert.ok(MEMBER_EXEC_TOOLS.includes(name), `${name} 不在 MEMBER_EXEC_TOOLS，成员根本分不到`);
  }
  const names = memberToolSchemas(["repo_map", "read_symbol"]).map((s) => s.function.name);
  assert.ok(names.includes("repo_map") && names.includes("read_symbol"));
});