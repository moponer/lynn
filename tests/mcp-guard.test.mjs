// 2026-11-13 审计 P1 修复回归：
//  - mcpChildEnv：MCP 子进程环境白名单（审计 #7——此前全量继承主进程 env）
//  - project.setRoot：未信任且带项目级 MCP 时返回 server 清单全文（审计 #7——信任确认页展示会跑什么命令）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mcpChildEnv } from "../dist/main/mcp.js";
import { Kernel } from "../dist/main/kernel.js";

test("mcpChildEnv：只给工具链必需键 + 显式声明项；没声明的拿不到", () => {
  const env = mcpChildEnv({ MY_TOKEN: "abc" });
  assert.ok(env.PATH, "PATH 必须保留（node/python 要靠它）");
  if (process.platform === "win32") assert.ok(env.SYSTEMROOT, "Windows 下 SYSTEMROOT 缺了子进程起不来");
  assert.equal(env.MY_TOKEN, "abc", "显式声明的键照传");
  assert.equal(env.LYNN_SECRET, undefined, "主进程里的敏感变量不透传");
  // 主进程env里造一个敏感变量验证白名单真的拦
  process.env.__LYNN_LEAK_TEST__ = "topsecret";
  try {
    assert.equal(mcpChildEnv({}).__LYNN_LEAK_TEST__, undefined);
  } finally {
    delete process.env.__LYNN_LEAK_TEST__;
  }
  // 显式声明可覆盖白名单值
  assert.equal(mcpChildEnv({ PATH: "/custom" }).PATH, "/custom");
});

test("project.setRoot：未信任 + 项目级 MCP → mcpServers 清单全文；env 只给键名", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mcpg-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mcgp-"));
  fs.mkdirSync(path.join(project, ".lynn"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".lynn", "mcp.json"),
    JSON.stringify({
      servers: [
        { id: "files", command: "npx", args: ["-y", "@model/files-mcp"], env: { FILES_ROOT: "/data", OTHER: "x" } },
      ],
    }),
    "utf-8",
  );
  const k = new Kernel(dataRoot);
  try {
    const r = await k.handle("project.setRoot", { root: project });
    assert.equal(r.ok, true);
    assert.equal(r.trusted, false, "新目录默认不信任");
    assert.equal(r.gated?.mcp, true);
    assert.equal(r.mcpServers?.length, 1);
    const s = r.mcpServers[0];
    assert.equal(s.id, "files");
    assert.equal(s.command, "npx");
    assert.deepEqual(s.args, ["-y", "@model/files-mcp"]);
    assert.deepEqual([...s.envKeys].sort(), ["FILES_ROOT", "OTHER"], "env 只列键名");
    assert.ok(!JSON.stringify(r.mcpServers).includes("/data"), "env 值不下发（信任确认页看不到值）");

    // 信任后不再带清单（已经加载了，无需再确认）
    k.handle("trust.set", { trusted: true });
    const r2 = await k.handle("project.setRoot", { root: project });
    assert.equal(r2.trusted, true);
    assert.equal(r2.mcpServers, undefined);
  } finally {
    await k.dispose();
  }
});
