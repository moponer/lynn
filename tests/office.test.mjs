// M2-06：office 能力层 —— CSV 零依赖降级、xlsx 引擎降级如实报、装配器校验
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCsv, toCsv, tableFromCsv, tableToCsv, probeSoffice, readTable, writeTable, pickMirror, assertSha256 } from "../dist/main/office.js";
import { Toolkit, TOOLKIT_SCHEMAS } from "../dist/main/toolkit.js";
import { MEMBER_EXEC_TOOLS, memberToolSchemas } from "../dist/main/member-runner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-off-"));
const NO_ENGINE = { found: false, kind: "none", detail: "无引擎" };

test("CSV：RFC4180 往返（引号/逗号/换行/中文）；空行剔除", () => {
  const rows = parseCsv('名称,备注\n"风铃,一","含""引号"""\r\n"多\n行",正常');
  assert.deepEqual(rows, [["名称", "备注"], ["风铃,一", '含"引号"'], ["多\n行", "正常"]]);
  const t = tableFromCsv('名称,数量\n钢笔,3\n\n墨,1');
  assert.deepEqual(t.headers, ["名称", "数量"]);
  assert.deepEqual(t.rows, [["钢笔", "3"], ["墨", "1"]], "空行剔除");
  const out = tableToCsv(t);
  const back = tableFromCsv(out);
  assert.deepEqual(back, t, "写读往返一致");
  assert.ok(toCsv([["a,b", 'c"d']]).includes('"a,b"'));
});

test("CSV 降级：不装引擎 read/write 照常；xlsx 如实报不可用；不产出坏 xlsx", () => {
  const root = tmp();
  const csv = path.join(root, "数据.csv");
  fs.writeFileSync(csv, "名称,数量\n钢笔,3", "utf-8");

  const r1 = readTable(csv, NO_ENGINE);
  assert.deepEqual(r1.table.headers, ["名称", "数量"], "CSV 不需要引擎");
  assert.ok(!("error" in r1));

  const r2 = readTable(path.join(root, "表.xlsx"), NO_ENGINE);
  assert.ok(r2.error?.includes("LibreOffice"), "xlsx 缺引擎如实说，不假装读出");
  assert.equal(r2.table, undefined);

  const w1 = writeTable(path.join(root, "out.csv"), { headers: ["a", "b"], rows: [["1", "2"]] });
  assert.equal(w1.ok, true);
  assert.ok(fs.readFileSync(path.join(root, "out.csv"), "utf-8").startsWith("a,b"));
  const w2 = writeTable(path.join(root, "out.xlsx"), { headers: ["a"], rows: [] });
  assert.equal(w2.ok, false, "xlsx 写入如实拒绝");
  assert.ok(!fs.existsSync(path.join(root, "out.xlsx")), "不产出坏文件");
});

test("装配器：镜像轮询 + sha256 校验拒收坏包", () => {
  const recipe = { id: "office", version: "1.0.0", installDir: "e", url: "https://official/x.tgz", mirrors: ["https://m1/x.tgz", "https://m2/x.tgz"] };
  assert.equal(pickMirror(recipe), "https://m1/x.tgz", "镜像优先");
  assert.equal(pickMirror(recipe, ["https://m1/x.tgz"]), "https://m2/x.tgz");
  assert.equal(pickMirror(recipe, ["https://m1/x.tgz", "https://m2/x.tgz"]), "https://official/x.tgz", "全挂才回官方");
  assert.equal(pickMirror(recipe, ["https://m1/x.tgz", "https://m2/x.tgz", "https://official/x.tgz"]), null);

  const buf = Buffer.from("hello engine");
  const good = crypto.createHash("sha256").update(buf).digest("hex");
  assert.doesNotThrow(() => assertSha256(buf, good));
  assert.throws(() => assertSha256(buf, "deadbeef".repeat(8)), /拒收/, "坏包拒收");
});

test("成员工具面：office 两件是执行类，路径钉在工作区；未装配如实提示", async () => {
  assert.ok(MEMBER_EXEC_TOOLS.includes("office_read_table"));
  assert.ok(MEMBER_EXEC_TOOLS.includes("office_write_table"));
  const names = TOOLKIT_SCHEMAS.map((s) => s.function.name);
  assert.ok(names.includes("office_read_table") && names.includes("office_write_table"));
  assert.ok(memberToolSchemas(["office_read_table", "submit_report"]).some((s) => s.function.name === "office_read_table"));

  const root = tmp();
  const calls = [];
  const tk = new Toolkit(root, {
    office: {
      read: (file) => {
        calls.push(["read", file]);
        return { table: { headers: ["x"], rows: [["1"]] } };
      },
      write: (file, t) => {
        calls.push(["write", file, t.headers]);
        return { ok: true };
      },
    },
  });
  await tk.execute("office_read_table", { path: "数据.csv" });
  assert.equal(calls[0][1], path.join(root, "数据.csv"), "读取路径钉在工作区");
  await tk.execute("office_write_table", { path: "out.csv", headers: ["a"], rows: [["1"]] });
  assert.equal(calls[1][1], path.join(root, "out.csv"));
  // 越界路径拒（resolveWithin 抛错）
  await assert.rejects(() => tk.execute("office_read_table", { path: "../outside.csv" }), "穿越路径被拒");

  // 未装配：如实提示，不假装失败原因
  const bare = new Toolkit(tmp());
  const msg = await bare.execute("office_read_table", { path: "a.csv" });
  assert.ok(msg.includes("未装配"));
});

test("probeSoffice：注入 fake exec；版本解析", async () => {
  const calls = [];
  const fake = (exe, args, opts, cb) => {
    calls.push(exe);
    if (exe === "C:\\fake\\soffice.exe") cb(null, "LibreOffice 25.2.1.2 12345", "");
    else cb(new Error("not found"), "", "");
  };
  // 探测顺序里第一个真实存在路径不存在，fake 只认 C:\fake —— 通过 LYNN_SOFFICE 注入
  process.env.LYNN_SOFFICE = "C:\\fake\\soffice.exe";
  try {
    const h = await probeSoffice(fake);
    assert.equal(h.found, true);
    assert.equal(h.version, "25.2.1.2");
    assert.ok(h.detail.includes("LibreOffice"));
  } finally {
    delete process.env.LYNN_SOFFICE;
  }
});
