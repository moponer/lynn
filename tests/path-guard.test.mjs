// 2026-11-13 审计三轮 P0 修复回归：
//  - path-guard：realpath containment（junction/符号链接逃逸收口）+ app.openPath 扩展名白名单
//  - log-policy：renderer.log 限流闸（每分钟上限 + 窗口翻转汇总）
//  - endpoint：统一风险闸 endpointRiskError（providers.discover 与 kernel.modelDiscover 同一道闸）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { insideBase, openPathBlockReason } from "../dist/main/path-guard.js";
import { newRendererLogGate, rendererLogGate, RENDERER_LOG_LIMITS } from "../dist/main/log-policy.js";
import { endpointRiskError } from "../dist/main/endpoint.js";

const tmp = (p = "lynn-guard-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("insideBase：普通内外判定；junction 逃逸被识破", (t) => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "inner"), { recursive: true });
  const outside = tmp("lynn-guard-out-");
  fs.writeFileSync(path.join(root, "inner", "a.md"), "hi");
  fs.writeFileSync(path.join(outside, "secret.md"), "no");

  assert.equal(insideBase(root, path.join(root, "inner", "a.md")), true);
  assert.equal(insideBase(root, path.join(outside, "secret.md")), false);
  // 不存在的目标（即将新建）：退回 resolve + relative 判定
  assert.equal(insideBase(root, path.join(root, "inner", "new.md")), true);
  assert.equal(insideBase(root, path.join(outside, "new.md")), false);
  // ".." 上跳
  assert.equal(insideBase(root, path.join(root, "..", "x.md")), false);

  // junction：字符串上"在根内"、实际指向根外——realpath 必须识破（审计 #10 的核心场景）
  const link = path.join(root, "inner", "escape");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    // 无权限建 junction 的环境显式跳过（判定逻辑已由上面用例覆盖），不许静默 return 假装通过
    t.skip("当前环境无权限创建 junction/符号链接");
    return;
  }
  assert.equal(insideBase(root, path.join(link, "secret.md")), false, "junction 指向根外必须判 outside");
  // junction 指向根内仍然放行
  const linkIn = path.join(root, "inner", "loop");
  fs.symlinkSync(path.join(root, "inner"), linkIn, "junction");
  assert.equal(insideBase(root, path.join(linkIn, "a.md")), true);
});

test("openPathBlockReason：白名单放行文档/压缩包/目录，脚本与可执行一律拒", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "exports"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"));
  const cases = [
    ["exports/task-1.zip", null],
    ["summary.md", null],
    ["report.csv", null],
    ["model.json", null],
    ["shot.png", null],
    ["logs/run.log", null],
    ["evil.bat", /白名单/],
    ["evil.ps1", /白名单/],
    ["evil.exe", /白名单/],
    ["evil.cmd", /白名单/],
    ["evil.vbs", /白名单/],
    ["evil.js", /白名单/],
    ["noext", /白名单/],
  ];
  for (const [rel, expect] of cases) {
    const target = path.join(root, rel);
    fs.writeFileSync(target, "x");
    const reason = openPathBlockReason(root, target);
    if (expect === null) assert.equal(reason, null, `${rel} 应放行`);
    else assert.match(reason, expect, `${rel} 应拒绝`);
  }
  // 目录放行（打开导出目录/日志目录的语义）
  assert.equal(openPathBlockReason(root, path.join(root, "logs")), null);
  // 根外拒绝（文案保持旧口径，前端有断言这个文案的展示）
  assert.match(openPathBlockReason(root, path.join(os.tmpdir(), "elsewhere.zip")), /数据目录/);
  // 不存在的文件
  assert.match(openPathBlockReason(root, path.join(root, "ghost.zip")), /不存在/);
});

test("rendererLogGate：每分钟限流；窗口翻转时带上一窗口丢弃汇总", () => {
  let st = newRendererLogGate();
  const t0 = 1_000_000;
  let out;
  for (let i = 0; i < RENDERER_LOG_LIMITS.maxPerMinute + 5; i++) {
    out = rendererLogGate(st, t0 + i);
    st = out.state;
  }
  assert.equal(out.write, false, "超过每分钟上限后要丢弃");
  assert.equal(st.dropped, 5);
  // 窗口翻转：放行并汇总上一窗口丢了多少条（丢失要有交代）
  const flip = rendererLogGate(st, t0 + 61_000);
  assert.equal(flip.write, true);
  assert.equal(flip.droppedSummary, 5);
  assert.equal(flip.state.dropped, 0);
  assert.equal(flip.state.count, 1);
});

test("endpointRiskError：remote 放行；local/insecure 要求显式确认，两处文案一致", () => {
  assert.equal(endpointRiskError("https://api.example.com/v1", false), null);
  assert.match(endpointRiskError("http://127.0.0.1:18899/v1", false, "发现模型"), /本机.*风险确认/);
  assert.match(endpointRiskError("http://example.com/v1", false, "发现模型"), /不是 HTTPS.*风险确认/);
  assert.equal(endpointRiskError("http://127.0.0.1:18899/v1", true), null, "显式确认后放行");
  // kernel.modelDiscover 与 providers.discover 必须是同一个函数产出的文案（审计 #6：两套标准）
  const local = endpointRiskError("http://localhost:1234/v1", false, "发现模型");
  assert.match(local, /请勾选风险确认后再发现模型/);
});
