// 性能验收：进待机跑 60s，按 5s 窗口统计动效层实际帧率。
// 用法：npx electron scripts/perf-run.cjs [秒数]
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const totalSec = Number(process.argv[2] || 60);
const outFile = path.join(__dirname, "..", "perf", "standby-fps.json");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true, // 必须可见，否则合成器不产出帧，测不到真实开销
    backgroundColor: "#0d1116",
    webPreferences: {
      preload: path.join(__dirname, "preview-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await win.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(`localStorage.setItem('lynn.onboarded','1'); location.reload();`);
  await new Promise((r) => setTimeout(r, 2000));

  // 进待机
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }))`,
  );
  await new Promise((r) => setTimeout(r, 1000));

  const read = () =>
    win.webContents.executeJavaScript(
      `(() => { const f = window.__lynnAmbientFrames || { frames: 0, since: performance.now() }; return { frames: f.frames, state: window.__lynnAmbientState || null }; })()`,
    );

  const samples = [];
  let prev = await read();
  const windows = Math.max(1, Math.round(totalSec / 5));
  for (let i = 0; i < windows; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = await read();
    const frames = cur.frames - prev.frames;
    samples.push({ windowSec: 5, frames, fps: Math.round((frames / 5) * 10) / 10, state: cur.state });
    console.log(`WINDOW ${i + 1}/${windows} frames=${frames} fps=${Math.round((frames / 5) * 10) / 10} interval=${cur.state?.interval}`);
    prev = cur;
  }

  const avg = samples.reduce((n, s) => n + s.fps, 0) / samples.length;
  const result = {
    mode: "standby",
    durationSec: totalSec,
    windows: samples,
    avgFps: Math.round(avg * 10) / 10,
    expectedInterval: samples[0]?.state?.interval ?? null,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log("RESULT", JSON.stringify({ avgFps: result.avgFps, expectedInterval: result.expectedInterval }));
  app.quit();
});
