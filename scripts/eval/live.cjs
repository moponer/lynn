// 真模型实测（生产 Pi 路径）：3 轮短对话，量 TTFT / 总延迟 / token / 缓存命中。
// 费用极小；数据根用临时目录，不污染用户真实会话；Key 用系统凭据库解密（不落盘明文）。
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

app.setPath("userData", path.join(app.getPath("appData"), "lynn"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-live-eval-"));
const realSettings = path.join(os.homedir(), ".lynn", "settings.json");
if (!fs.existsSync(realSettings)) {
  console.log("LIVE-EVAL: NO_SETTINGS");
  app.exit(2);
} else {
  fs.copyFileSync(realSettings, path.join(home, "settings.json"));
}
process.env.LYNN_HOME = home;
process.env.LYNN_PROJECT_DIR = home;

const outDir = path.join(__dirname, "..", "..", "perf", "eval");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const { Kernel } = require(path.join(__dirname, "..", "..", "dist", "main", "kernel.js"));
  const k = new Kernel(home);
  k.setEncryptors(
    (plain) => safeStorage.encryptString(plain),
    () => safeStorage.isEncryptionAvailable(),
    (blob) => safeStorage.decryptString(blob),
  );
  const tInit = performance.now();
  await k.init();
  const initMs = Math.round(performance.now() - tInit);
  const snap0 = k.handle("session.snapshot");
  if (!snap0.model.configured) {
    console.log("LIVE-EVAL: NO_MODEL");
    app.exit(2);
    return;
  }

  const rounds = [];
  for (let i = 0; i < 3; i += 1) {
    const row = await new Promise((resolve) => {
      const t0 = performance.now();
      let ttft = null;
      let settled = false;
      const off = k.onEvent((ev) => {
        if (ev.type === "delta" && ev.text && ttft === null) ttft = performance.now();
        if (ev.type === "done" || ev.type === "error") finish(ev.type, ev.message);
      });
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        const s = k.handle("session.snapshot");
        const last = [...s.feed].reverse().find((c) => c.kind === "lynn");
        const u = s.usage;
        const prompt = u.sessionIn + u.cacheRead + u.cacheWrite;
        resolve({
          round: i + 1,
          status,
          error,
          ttftMs: ttft === null ? null : Math.round(ttft - t0),
          totalMs: Math.round(performance.now() - t0),
          reply: (last?.text ?? "").slice(0, 120),
          turnIn: u.turnIn,
          turnOut: u.turnOut,
          sessionIn: u.sessionIn,
          sessionOut: u.sessionOut,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          contextTokens: u.contextTokens,
          contextPercent: u.contextPercent,
          hitRatePct: prompt > 0 ? Math.round((u.cacheRead / prompt) * 1000) / 10 : null,
        });
      };
      const timer = setTimeout(() => finish("timeout", "120s 超时"), 120_000);
      k.handle("feed.send", { text: "只回复两个字：收到" });
    });
    rounds.push(row);
    console.log("LIVE-ROUND", JSON.stringify(row));
  }

  const result = {
    at: new Date().toISOString(),
    provider: snap0.model.provider,
    model: snap0.model.model,
    initMs,
    rounds,
    p50TotalMs: (() => {
      const xs = rounds.map((r) => r.totalMs).sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    })(),
    tokensTotal: rounds.reduce((n, r) => n + (r.turnIn ?? 0) + (r.turnOut ?? 0), 0),
    cacheReported: rounds.some((r) => r.cacheRead > 0 || r.cacheWrite > 0),
  };
  fs.writeFileSync(path.join(outDir, `live-${stamp}.json`), JSON.stringify(result, null, 2), "utf-8");
  console.log("LIVE-EVAL RESULT", JSON.stringify(result));
  await k.dispose().catch(() => undefined);
  app.exit(0);
});

setTimeout(() => {
  console.log("LIVE-EVAL: HARD_TIMEOUT");
  app.exit(9);
}, 400_000);
