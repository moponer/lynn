// 走查模式：trustask
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "trustask",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.wsmenu-btn, .crumb-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    // 点「换工作区…」→ 假桥返回带 gated 的结果 → 应当弹信任询问
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.jobmenu-item')].find(x=>x.textContent.includes('换工作区')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const info = await win.webContents.executeJavaScript(`(() => ({
      ask: !!document.querySelector('.perm-ask'),
      title: document.querySelector('.perm-ask-head span')?.textContent.trim() ?? null,
      body: document.querySelector('.perm-ask-body')?.textContent.trim() ?? null,
      buttons: [...document.querySelectorAll('.perm-ask-acts .perm-btn')].map(b => b.textContent.trim()),
    }))()`);
    console.log("TRUSTASK", JSON.stringify({ clicked, ...info }));
  },
};
