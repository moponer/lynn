// 走查模式：advisor —— 我的风铃 → 权限：读「顾问审阅」一行的标题/说明/开关文案
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 里给 win（BrowserWindow）。
module.exports = {
  mode: "advisor",
  async run({ win }) {
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>x.textContent.includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1200));
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>x.textContent.trim()==='权限'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const info = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.sf-row')];
      const row = rows.find((r) => r.textContent.includes('顾问审阅'));
      if (!row) return { found: false };
      return { found: true, text: row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160), btn: row.querySelector('button')?.textContent ?? '' };
    })()`);
    console.log("ADVISOR", opened, navOk, JSON.stringify(info));
  },
};
