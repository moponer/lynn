// 走查模式：sealnext
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "sealnext",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const before = await win.webContents.executeJavaScript(
      `document.querySelector('.seal-pager .chip')?.textContent ?? "no-pager"`,
    );
    const ok = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.seal-pager .icon-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const after = await win.webContents.executeJavaScript(
      `document.querySelector('.seal-pager .chip')?.textContent ?? "no-pager"`,
    );
    console.log("SEALNEXT", before, "->", after, "clicked:", ok);
  },
};
