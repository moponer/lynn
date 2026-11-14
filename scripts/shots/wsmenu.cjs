// 走查模式：wsmenu
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "wsmenu",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.rail-seg-item')][1]; if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(
      `(() => { const j=document.querySelector('.job[role="button"]'); if (j) j.click(); return !!j; })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=document.querySelector('.wsmenu-wrap .crumb-btn'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const info = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.wsmenu');
      if (!m) return { open: false };
      const r = m.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + Math.min(40, r.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      return {
        open: true,
        pos: getComputedStyle(m).position,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        covered: !(hit === m || m.contains(hit)),
        hit: hit ? hit.className : null,
      };
    })()`);
    console.log("WSMENU", opened, info);
  },
};
