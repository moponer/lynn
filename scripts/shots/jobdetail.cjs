// 走查模式：jobdetail
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "jobdetail",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[role="button"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const info = await win.webContents.executeJavaScript(`(() => ({
      steps: document.querySelectorAll('.step').length,
      ring: document.querySelectorAll('.step-ring').length,
      now: [...document.querySelectorAll('.step')].findIndex(x => x.classList.contains('now')),
      tabs: document.querySelectorAll('.tab').length,
      lines: document.querySelectorAll('.step-line').length,
      toolbar: !!document.querySelector('.sheet-toolbar'),
      segWrap: [...document.querySelectorAll('.rail-seg-item')].map(x => x.getBoundingClientRect().height),
    }))()`);
    console.log("JOBDETAIL", ok, info);
  },
};
