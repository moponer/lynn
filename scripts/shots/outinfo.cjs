// 走查模式：outinfo
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "outinfo",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
      // 点「查看所属」→ 资料卡应报出项目/目标/产出者/路径
      await win.webContents.executeJavaScript(
        `(() => { const b=[...document.querySelectorAll('.jobmenu-item')].find(x=>x.textContent.includes('查看所属')); if (b) b.click(); return !!b; })()`,
      );
      await new Promise((r) => setTimeout(r, 350));
      const card = await win.webContents.executeJavaScript(`(() => ({
        open: !!document.querySelector('.mdetail-card'),
        head: document.querySelector('.mdetail-id b')?.textContent.trim() ?? null,
        role: document.querySelector('.mdetail-role')?.textContent.trim() ?? null,
        rows: [...document.querySelectorAll('.mdetail-row')].map(r => [
          r.querySelector('dt')?.textContent.trim(), r.querySelector('dd')?.textContent.trim(),
        ]),
      }))()`);
      console.log("OUTINFO", JSON.stringify(card));
  },
};
