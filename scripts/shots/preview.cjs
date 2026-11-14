// 走查模式：preview
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "preview",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][2]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const ok = await win.webContents.executeJavaScript(
      `(() => { const r=[...document.querySelectorAll('.thread-row')].find(x=>!x.disabled); if (r) r.click(); return !!r; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log(
      "PREVIEW",
      ok,
      "drawer:",
      await win.webContents.executeJavaScript(`!!document.querySelector('.pv-drawer')`),
      "code:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.hljs-keyword').length`),
    );
  },
};
