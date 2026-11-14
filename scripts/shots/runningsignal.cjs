// 走查模式：runningsignal
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "runningsignal",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    // 1) 左栏切到「工单」视图
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    // 2) 点开当前在跑的那张单（data-running="1"），中心进入工单详情
    const opened = await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[data-running="1"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    // 3) 工单详情默认在「对话」tab，切到「往来」才能看到带 jobId 的进度卡
    const fedTab = await win.webContents.executeJavaScript(
      `(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('往来')); if (t) t.click(); return !!t; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const info = await win.webContents.executeJavaScript(`(() => ({
      opened: ${opened ? "true" : "false"},
      fedTab: ${fedTab ? "true" : "false"},
      memberRunning: document.querySelectorAll('.mcard[data-state="running"]').length,
      memberDots: document.querySelectorAll('.mcard-live').length,
      jobRunning: document.querySelectorAll('.job[data-running="1"]').length,
      jobPips: document.querySelectorAll('.job[data-running="1"] .pip').length,
      liveCards: document.querySelectorAll('.feed-item.tool.progress.live').length,
      liveDots: document.querySelectorAll('.feed-item.tool.progress.live .live-dot').length,
      liveText: [...document.querySelectorAll('.feed-live-text')].map(x => x.textContent),
    }))()`);
    console.log("RUNSIGNAL", info);
  },
};
