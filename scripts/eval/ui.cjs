// 前端实测：Playwright 驱动真实 Electron 主进程 + 真实内核 + 独立 mock 模型。
// 覆盖：启动、对话发送/回复、工作区菜单、命令面板、设置-数据页、工单/证据/交付物、右键菜单、交付箱、控制台、cd。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { _electron: electron } = require("playwright-core");

const repo = path.resolve(__dirname, "..", "..");
const outDir = path.join(repo, "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const home = tmp("lynn-ui-home-");
const project = tmp("lynn-ui-proj-");
const userData = tmp("lynn-ui-ud-");

function startMock(opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "mock-server.cjs"), JSON.stringify(opts)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n")[0];
      if (!line) return;
      try {
        const info = JSON.parse(line);
        const control = `${info.baseUrl.replace(/\/v1$/, "")}/__control`;
        const post = async (payload) => {
          await fetch(control, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        };
        resolve({
          baseUrl: info.baseUrl,
          setMode: (mode) => post({ mode }),
          setReply: (reply) => post({ reply }),
          requests: async () => {
            const r = await fetch(control);
            const j = await r.json();
            return j.requests ?? 0;
          },
          close: () => new Promise((r) => { child.once("exit", r); child.kill(); }),
        });
      } catch {
        /* wait */
      }
    });
    child.on("error", reject);
  });
}

function writeSettings(baseUrl) {
  const at = new Date().toISOString();
  const entry = { id: "m-mock", label: "Mock", provider: "Mock", baseUrl, model: "mock-1", apiKey: { encrypted: false, data: "mock-key" }, updatedAt: at };
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ model: entry, models: [entry], defaultModelId: "m-mock", prefs: { heartbeat: false, supervisor: false, autoStart: false, trayOnClose: false } }, null, 2),
    "utf-8",
  );
}

function seedTask() {
  const id = "WO-EVAL-1";
  const dir = path.join(home, "tasks", id);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "artifacts", "report.md"), "# 评测交付物\n\n- 数值：42\n", "utf-8");
  const now = new Date().toISOString();
  const rec = {
    id,
    title: "季度订单核对与交付",
    teamId: "eval-team",
    status: "in_review",
    version: 3,
    parentId: null,
    member: "阿明",
    evidence: [{ id: "ev-1", kind: "artifact", label: "report.md", ref: "artifacts/report.md", verified: true, at: now }],
    rejectRounds: 0,
    rejectLimit: 3,
    approvals: [],
    reviewer: "user",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: project,
    workspace: { mode: "project", root: project, deliverablesDir: path.join(project, "deliverables", id), scratchDir: path.join(dir, "scratch") },
    deliverables: [{ path: "report.md", ref: "artifacts/report.md", bytes: 27, at: now }],
  };
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(rec, null, 2), "utf-8");
}

async function main() {
  console.log("ui-eval: starting mock");
  const mock = await startMock({ mode: "ok", chunks: 3, reply: "收到，我是风铃。" });
  console.log("ui-eval: mock at", mock.baseUrl);
  writeSettings(mock.baseUrl);
  // 先不播种工单：有工单时中心区显示工单详情，会隐藏「频道」流，看不到对话卡。
  // 对话/失败恢复测完再写 task.json 并 reload。
  // 控制台插件（官方 L0）：拷进临时数据根，让 stage.console 卡槽有内容
  const consolePlugin = path.join(os.homedir(), ".lynn", "plugins", "lynn.view.console");
  if (fs.existsSync(consolePlugin)) {
    fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
    fs.cpSync(consolePlugin, path.join(home, "plugins", "lynn.view.console"), { recursive: true });
  }

  const started = Date.now();
  const app = await electron.launch({
    args: [path.join(__dirname, "eval-main.cjs")],
    cwd: repo,
    env: {
      ...process.env,
      LYNN_HOME: home,
      LYNN_PROJECT_DIR: project,
      LYNN_EVAL_USER_DATA: userData,
      LYNN_LOW_MEMORY: process.env.LYNN_LOW_MEMORY ?? "",
      LYNN_EVAL_SINGLE_PROCESS: process.env.LYNN_EVAL_SINGLE_PROCESS ?? "",
      LYNN_EVAL_NO_NETWORK_SERVICE: process.env.LYNN_EVAL_NO_NETWORK_SERVICE ?? "",
      NODE_TEST_CONTEXT: "eval",
      LYNN_UPDATE_FEED: "",
    },
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  console.log("launched:", win.url());
  const errors = [];
  win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  win.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  const steps = [];
  const uiFacts = {};
  global.__uiEval = { steps, errors, uiFacts };
  const step = async (name, fn) => {
    const t0 = Date.now();
    console.log(`[step] ${name} ...`);
    try {
      await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`[step] ${name} OK ${Date.now() - t0}ms`);
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
      console.log(`[step] ${name} FAILED ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  // 隔离后的 localStorage 是空的，而 App 默认进「控制台」（readStageView 只认 desk）。
  // 先写 desk 再 reload，并把窗口提到前台：后台 rAF 被节流会让流式卡片不进 DOM。
  await win.evaluate(() => {
    localStorage.setItem("lynn.onboarded", "1");
    localStorage.setItem("lynn.stage.view", "desk");
  });
  await win.reload();
  await win.bringToFront();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(
    "precheck",
    JSON.stringify(
      await win.evaluate(() => ({
        composer: document.querySelectorAll(".composer-in").length,
        rail: document.querySelectorAll(".rail-seg").length,
        wiz: document.querySelectorAll(".wiz").length,
        text: document.body.innerText.slice(0, 240),
      })),
    ),
    "errors=",
    JSON.stringify(errors.slice(0, 4)),
  );

  await step("启动到主界面", async () => {
    await win.waitForSelector(".composer-in", { timeout: 90_000 });
    await win.waitForSelector(".rail-seg", { timeout: 30_000 });
  });
  const bootMs = Date.now() - started;

  await step("发送消息并收到回复", async () => {
    await win.fill(".composer-in", "你好，做个自检");
    await win.click(".composer-row .send");
    let inDom = true;
    try {
      await win.waitForFunction(() => document.body.innerText.includes("收到，我是风铃。"), null, { timeout: 6_000 });
    } catch {
      inDom = false;
    }
    uiFacts.chatRenderedInDom = inDom;
    const snap = await win.evaluate(async () => {
      const s = await window.lynn.rpc("session.snapshot");
      return { turn: s.turn, last: s.feed.slice(-2).map((c) => ({ kind: c.kind, text: c.text })), model: s.model };
    });
    assert.ok(
      snap.last.some((c) => c.kind === "lynn" && (c.text ?? "").includes("收到，我是风铃。")),
      `内核快照里没有回复：${JSON.stringify(snap)}`,
    );
    assert.equal(snap.turn.busy, false, "回合结束后 busy 必须回落");
    uiFacts.chatSnapshot = snap;
  });

  await step("前端失败可见且可恢复", async () => {
    await mock.setMode("fail500");
    await win.fill(".composer-in", "触发失败");
    await win.click(".composer-row .send");
    let errInDom = true;
    try {
      await win.waitForFunction(() => document.body.innerText.includes("5xx"), null, { timeout: 8_000 });
    } catch {
      errInDom = false;
    }
    uiFacts.errorRenderedInDom = errInDom;
    const last = await win.evaluate(async () => (await window.lynn.rpc("session.snapshot")).feed.slice(-4));
    assert.ok(
      last.some((c) => c.kind === "error" || /5xx|失败|错误/.test(c.text ?? "")),
      `错误卡没落进快照：${JSON.stringify(last.map((c) => ({ kind: c.kind, text: c.text })))}`,
    );
    await mock.setMode("ok");
    await mock.setReply("恢复成功：Lynn-OK-RECOVER");
    await win.fill(".composer-in", "恢复自检");
    await win.click(".composer-row .send");
    let recInDom = true;
    try {
      await win.waitForFunction(() => document.body.innerText.includes("恢复成功：Lynn-OK-RECOVER"), null, { timeout: 8_000 });
    } catch {
      recInDom = false;
      console.log("DEBUG recovery body", (await win.evaluate(() => document.body.innerText)).slice(-700));
      console.log("DEBUG recovery mock req", await mock.requests());
    }
    uiFacts.recoveryRenderedInDom = recInDom;
    const recSnap = await win.evaluate(async () => {
      const s = await window.lynn.rpc("session.snapshot");
      return { turn: s.turn, feed: s.feed.slice(-5).map((c) => ({ kind: c.kind, text: c.text })) };
    });
    console.log("DEBUG recovery snap", JSON.stringify(recSnap));
    assert.ok(
      recSnap.feed.some((c) => c.kind === "lynn" && (c.text ?? "").includes("恢复成功：Lynn-OK-RECOVER")),
      "恢复后的回复没进快照",
    );
  });

  await step("播种工单并刷新出台账", async () => {
    seedTask();
    await win.reload();
    await win.waitForSelector(".rail-seg", { timeout: 25_000 });
    await win.locator(".rail-seg-item", { hasText: "工单" }).click();
    await win.waitForSelector(".job", { timeout: 15_000 });
  });

  await step("刷新后默认仍是会话频道（对话不被工单抢走）", async () => {
    await win.waitForFunction(
      () => {
        const b = document.body.innerText;
        // 频道会折叠历史：只断言空场标题 + 最近一轮（用户/风铃）可见
        return b.includes("说吧，要办什么") && (b.includes("恢复自检") || b.includes("恢复成功：Lynn-OK-RECOVER"));
      },
      null,
      { timeout: 10_000 },
    );
    uiFacts.defaultViewIsChannel = true;
  });

  await step("工作区菜单三项可见", async () => {
    await win.click(".crumb-chip");
    await win.waitForSelector(".wsmenu", { timeout: 5_000 });
    const text = await win.locator(".wsmenu").innerText();
    for (const k of ["换工作区", "这次不用工作区", "添加只读目录"]) assert.ok(text.includes(k), `菜单缺：${k}`);
    await win.keyboard.press("Escape");
  });

  await step("命令面板含工作区动作", async () => {
    await win.keyboard.press("Control+k");
    await win.waitForSelector(".cmdk", { timeout: 5_000 });
    const text = await win.locator(".cmdk").innerText();
    for (const k of ["换工作区", "这次不用工作区", "加只读目录"]) assert.ok(text.includes(k), `命令面板缺：${k}`);
    await win.keyboard.press("Escape");
  });

  await step("设置-数据页：工作区与存储", async () => {
    await win.getByRole("button", { name: /我的风铃/ }).first().click();
    await win.waitForSelector(".sf-shell", { timeout: 10_000 });
    await win.locator(".sf-nav button", { hasText: "数据" }).first().click();
    await win.waitForSelector("text=存储与清理", { timeout: 8_000 });
    const text = await win.locator(".sf-pane").innerText();
    for (const k of ["默认工作区", "常用只读根", "总占用", "清理过程文件"]) assert.ok(text.includes(k), `数据页缺：${k}`);
    await win.screenshot({ path: path.join(outDir, `ui-settings-${stamp}.png`) });
    await win.keyboard.press("Escape");
    await win.waitForSelector(".sf-shell", { state: "detached", timeout: 5_000 });
  });

  await step("设置-模型页含发现模型/检测/风险标记", async () => {
    await win.getByRole("button", { name: /我的风铃/ }).first().click();
    await win.waitForSelector(".sf-shell", { timeout: 10_000 });
    await win.locator(".sf-nav button", { hasText: "模型" }).first().click();
    await win.waitForSelector(".sf-row .sf-btn", { timeout: 8_000 });
    await win.locator(".sf-row .sf-btn", { hasText: "编辑" }).first().click();
    await win.waitForSelector("text=发现模型", { timeout: 5_000 });
    const text = await win.locator(".sf-pane").innerText();
    for (const k of ["本地 / 免费模型", "重新检测", "检测", "发现模型", "本机/局域网", "未确认风险"]) {
      assert.ok(text.includes(k), `模型页缺：${k}`);
    }
    await win.keyboard.press("Escape");
    await win.waitForSelector(".sf-shell", { state: "detached", timeout: 5_000 });
  });

  await step("台账显示工单", async () => {
    await win.locator(".rail-seg-item", { hasText: "工单" }).click();
    await win.waitForSelector(".job", { timeout: 8_000 });
    const text = await win.locator(".job").first().innerText();
    assert.ok(text.includes("季度订单核对"), `台账没有工单：${text}`);
  });

  await step("工单详情保留对话并可一键回到频道", async () => {
    await win.locator(".job").first().click();
    await win.waitForSelector(".sheet-title", { timeout: 8_000 });
    const tabs = await win.locator(".tabs .tab").allInnerTexts();
    assert.ok(tabs.some((x) => x.includes("对话")), `工单详情缺「对话」页签：${tabs.join(" | ")}`);
    const body = await win.locator("body").innerText();
    assert.ok(body.includes("你好，做个自检"), "工单详情里看不到本会话用户消息");
    await win.locator(".eyebrow-link", { hasText: "回到对话" }).click();
    await win.waitForFunction(() => document.body.innerText.includes("说吧，要办什么"), null, { timeout: 8_000 });
    uiFacts.jobKeepsChannel = true;
  });

  await step("工单详情：交付物与证据", async () => {
    await win.locator(".job").first().click();
    await win.waitForSelector(".sheet-title", { timeout: 8_000 });
    await win.locator(".tab", { hasText: "证据" }).click();
    await win.waitForSelector("text=交付物", { timeout: 5_000 });
    const text = await win.locator(".evidence-view").innerText();
    assert.ok(text.includes("report.md"), "交付物列表缺文件");
    assert.ok(text.includes("证据链"), "证据链区块缺失");
  });

  await step("右键菜单含导出与审查快照", async () => {
    await win.locator(".job").first().click({ button: "right" });
    await win.waitForSelector(".jobmenu", { timeout: 5_000 });
    const text = await win.locator(".jobmenu").innerText();
    assert.ok(text.includes("导出卷宗 zip"), "缺少导出入口");
    assert.ok(text.includes("拷进任务沙箱"), "缺少审查快照入口");
    await win.keyboard.press("Escape");
  });

  await step("交付箱汇总交付物", async () => {
    await win.locator(".rail-seg-item", { hasText: "交付箱" }).click();
    await win.waitForSelector("text=report.md", { timeout: 5_000 });
  });

  await step("切到控制台并执行 cd", async () => {
    await win.evaluate(() => localStorage.setItem("lynn.stage.view", "console"));
    await win.reload();
    await win.waitForSelector(".cs-shell", { timeout: 30_000 });
    await win.fill(".cs-cmdline input", "cd --none");
    await win.keyboard.press("Enter");
    await win.waitForFunction(() => document.body.innerText.includes("这次不用工作区"), null, { timeout: 8_000 });
    await win.screenshot({ path: path.join(outDir, `ui-console-${stamp}.png`) });
  });

  const nav = await win.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoaded: Math.round(n?.domContentLoadedEventEnd ?? 0),
      loadEvent: Math.round(n?.loadEventEnd ?? 0),
      domNodes: document.querySelectorAll("*").length,
    };
  });
  const fps1s = await win.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpuPct: Math.round(m.cpu.percentCPUUsage * 10) / 10,
      memMB: Math.round((m.memory.workingSetSize / 1024) * 10) / 10,
    })),
  );

  const report = {
    at: new Date().toISOString(),
    bootMs,
    steps,
    uiFacts,
    failedSteps: steps.filter((s) => !s.ok).length,
    consoleErrors: errors,
    renderer: nav,
    idleFps1s: fps1s,
    processMetrics: metrics,
    totalMemMB: Math.round(metrics.reduce((n, m) => n + m.memMB, 0) * 10) / 10,
    totalCpuPct: Math.round(metrics.reduce((n, m) => n + m.cpuPct, 0) * 10) / 10,
  };
  fs.writeFileSync(path.join(outDir, `ui-${stamp}.json`), JSON.stringify(report, null, 2), "utf-8");
  console.log(JSON.stringify(report, null, 2));
  await app.close();
  await mock.close();
}

main().catch((err) => {
  console.error("UI-EVAL-FAILED:", err);
  fs.writeFileSync(
    path.join(outDir, `ui-${stamp}-FAILED.json`),
    JSON.stringify({ at: new Date().toISOString(), error: String(err), partial: global.__uiEval ?? null }, null, 2),
    "utf-8",
  );
  setTimeout(() => process.exit(1), 50);
});
