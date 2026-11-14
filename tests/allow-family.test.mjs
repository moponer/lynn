// 「这类以后都允许」（2026-11-14）：按删除族放行，只关掉弹卡，不放宽路径守卫
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { destructiveFamily } from "../dist/main/toolkit.js";
import { Kernel } from "../dist/main/kernel.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fam-"));

async function until(fn, ms = 3000, label = "条件") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`等待超时：${label}`);
}

test("删除族判定：只在真删除/移动时给族，普通命令没有", () => {
  assert.equal(destructiveFamily("del a.txt"), "delete");
  assert.equal(destructiveFamily("rm -rf build"), "delete");
  assert.equal(destructiveFamily("mv a b"), "move");
  assert.equal(destructiveFamily("git clean -fd"), "git-clean");
  assert.equal(destructiveFamily("git reset --hard HEAD~1"), "git-reset");
  assert.equal(destructiveFamily("echo hello"), null);
});

test("放行过的族不再弹卡；没放行的仍然挂审批", async () => {
  const root = tmp();
  const kernel = new Kernel(root);
  try {
    await kernel.init();
    kernel.handle("config.prefs", { autoStart: false });

    // 没放行：挂一张审批卡
    const waiting = kernel.awaitCommandApproval("林工", "t1", "del a.txt");
    await until(() => kernel.handle("session.snapshot").board.decisions.some((d) => d.kind === "approval"), 3000, "审批卡");
    const d = kernel.handle("session.snapshot").board.decisions.find((x) => x.kind === "approval");
    assert.equal(d.family, "delete");
    kernel.handle("decision.resolve", { id: d.id, action: "start", always: true });
    assert.equal((await waiting).ok, true);
    assert.deepEqual(kernel.settings.getPrefs().allowCommandFamilies, ["delete"]);

    // 放行之后：同族直接过，不弹卡
    const before = kernel.handle("session.snapshot").board.decisions.length;
    const r = await kernel.awaitCommandApproval("林工", "t1", "rm b.txt");
    assert.equal(r.ok, true);
    assert.equal(kernel.handle("session.snapshot").board.decisions.length, before, "不该再弹卡");

    // 别的族仍然要审批（放行 delete 不等于放行 git reset）
    const other = kernel.awaitCommandApproval("林工", "t1", "git reset --hard HEAD");
    await until(() => kernel.handle("session.snapshot").board.decisions.some((x) => x.kind === "approval" && x.family === "git-reset"), 3000, "别的族仍弹卡");
    const d2 = kernel.handle("session.snapshot").board.decisions.find((x) => x.kind === "approval" && x.family === "git-reset");
    kernel.handle("decision.resolve", { id: d2.id, action: "reject" });
    assert.equal((await other).ok, false);
  } finally {
    await kernel.dispose();
  }
});
