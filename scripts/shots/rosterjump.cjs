// 走查模式：rosterjump
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "rosterjump",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const before = await win.webContents.executeJavaScript(
      `document.querySelector('.tg-goto')?.textContent.trim() ?? null`,
    );
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.tg-goto'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const after = await win.webContents.executeJavaScript(`(() => ({
      mine: [...document.querySelectorAll('.tgroup-others-h')].map(h => h.textContent.trim()),
      gotoLeft: document.querySelectorAll('.tg-goto').length,
    }))()`);
    console.log("ROSTERJUMP", JSON.stringify({ before, clicked, after }));
  },
};
