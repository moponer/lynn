// 走查模式：threadedit
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "threadedit",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.thread-cur'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    const clickedRename = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const pen = row && row.querySelector('.thread-act');
      if (!pen) return false;
      pen.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const renameOpen = await win.webContents.executeJavaScript(`!!document.querySelector('.thread-rename')`);
    await win.webContents.executeJavaScript(
      `(() => { const el=document.querySelector('.thread-rename'); if (el) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const renameClosed = await win.webContents.executeJavaScript(`!document.querySelector('.thread-rename')`);
    const clickedDelete = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const del = row && row.querySelectorAll('.thread-act')[1];
      if (!del) return false;
      del.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    console.log(
      "THREADEDIT",
      "rename:",
      clickedRename,
      renameOpen,
      renameClosed,
      "delete:",
      clickedDelete,
      await win.webContents.executeJavaScript(`!!document.querySelector('.thread-ask')`),
    );
  },
};
