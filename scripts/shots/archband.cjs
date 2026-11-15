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
    // 点 ×：必须走统一确认卡片（2026-11-15 起不再就地变红字"确认删除"）
    const asked = await win.webContents.executeJavaScript(`(() => {
      const d = document.querySelector('.arch-del');
      if (!d) return null;
      d.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 420));
    const card = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.ask-card');
      if (!c) return null;
      return {
        title: c.querySelector('.ask-title')?.textContent.trim() ?? null,
        btns: [...c.querySelectorAll('.ask-btn')].map((b) => b.textContent.trim()),
        focused: document.activeElement?.textContent?.trim() ?? null,
      };
    })()`);
    console.log("ARCHASK", asked, JSON.stringify(card));
    // 收起来，截图回到归档带本身（Esc 落在"取消"上）
    await win.webContents.executeJavaScript(`(() => {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    // 只为走查：让第一行的删除动作显形，验证常态是不显的、hover 才有 ×
    await win.webContents.executeJavaScript(
      `(() => { const d = document.querySelector('.arch-del'); if (d) d.style.opacity = '1'; })()`,
    );
  },
};
