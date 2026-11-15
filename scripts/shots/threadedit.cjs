// 走查模式：threadedit
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
// 2026-11-15：删除入口已收进 ⋯ 菜单 + 统一确认卡片（不再有列表内联 .thread-ask）。
module.exports = {
  mode: "threadedit",
  async run({ win }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.thread-cur'); if (b) b.click(); return !!b; })()`,
    );
    await wait(600);
    // 改名：⋯ 菜单 → 改名
    const clickedRename = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const more = row && row.querySelector('.thread-more');
      if (!more) return false;
      more.click();
      return true;
    })()`);
    await wait(300);
    await win.webContents.executeJavaScript(`(() => {
      const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => /改名|重命名/.test(x.textContent));
      it?.click();
    })()`);
    await wait(350);
    const renameOpen = await win.webContents.executeJavaScript(`!!document.querySelector('.thread-rename')`);
    await win.webContents.executeJavaScript(
      `(() => { const el=document.querySelector('.thread-rename'); if (el) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`,
    );
    await wait(300);
    const renameClosed = await win.webContents.executeJavaScript(`!document.querySelector('.thread-rename')`);

    // 删除：⋯ 菜单 → 删除 → 确认卡片（不是列表里的内联问句）
    const clickedDelete = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.thread-line')[1] || document.querySelector('.thread-line');
      const more = row && row.querySelector('.thread-more');
      if (!more) return false;
      more.click();
      return true;
    })()`);
    await wait(300);
    await win.webContents.executeJavaScript(`(() => {
      const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => x.textContent.includes('删除'));
      it?.click();
    })()`);
    await wait(450);
    console.log(
      "THREADEDIT",
      "rename:",
      clickedRename,
      renameOpen,
      renameClosed,
      "delete:",
      clickedDelete,
      await win.webContents.executeJavaScript(`!!document.querySelector('.thread-ask')`),
      "card:",
      await win.webContents.executeJavaScript(`document.querySelector('.ask-card .ask-title')?.textContent.trim() ?? null`),
    );
  },
};
