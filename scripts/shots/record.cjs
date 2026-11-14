// 走查模式：record
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "record",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.mcard-record-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 450));
    const text = await win.webContents.executeJavaScript(
      `document.querySelector('.mcard-stat')?.textContent ?? ''`,
    );
    console.log("RECORD", clicked, JSON.stringify(text));
  },
};
