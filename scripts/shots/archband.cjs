// 走查模式：archband
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "archband",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 600));
    const info = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelectorAll('.arch-row');
      const del = document.querySelector('.arch-del');
      return {
        rows: rows.length,
        delOpacity: del ? getComputedStyle(del).opacity : 'none',
        delLabels: [...document.querySelectorAll('.arch-del')].map(x => x.textContent.trim()).slice(0, 3),
        more: !!document.querySelector('.archive-band .strip-link'),
      };
    })()`);
    console.log("ARCHBAND", info);
    // 只为走查：让第一行的删除动作显形，验证常态是不显的、hover 才有 ×
    await win.webContents.executeJavaScript(
      `(() => { const d = document.querySelector('.arch-del'); if (d) d.style.opacity = '1'; })()`,
    );
  },
};
