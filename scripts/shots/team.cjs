// 走查模式：team
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "team",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.includes('团队')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    console.log(
      "TEAM",
      opened,
      navOk,
      "blocks:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-block').length`),
      "members:",
      await win.webContents.executeJavaScript(`document.querySelectorAll('.team-block .sf-row').length`),
    );
  },
};
