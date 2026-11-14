// 走查模式：e3
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "e3",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.sealcard .btn-reject'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.seal-reject .seal-field').length`);
    console.log("E3", ok, "fields:", n);
  },
};
