// 走查模式：rostername
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "rostername",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const before = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.panel-h-acts .icon-btn').length`,
    );
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.panel-h-acts .icon-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const after = await win.webContents.executeJavaScript(`(() => ({
      input: !!document.querySelector('.roster-actions input'),
      placeholder: document.querySelector('.roster-actions input')?.getAttribute('placeholder') ?? null,
      buttons: [...document.querySelectorAll('.roster-actions .ghost-btn')].map(b => b.textContent.trim()),
      titles: [...document.querySelectorAll('.panel-h-acts .icon-btn')].map(b => b.getAttribute('title')),
    }))()`);
    console.log("ROSTERNAME", JSON.stringify({ before, clicked, ...after }));
  },
};
