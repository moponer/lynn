// 走查模式：groupp1
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "groupp1",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => ({
      threadRows: document.querySelectorAll('.thread-row').length,
      threadAv: document.querySelectorAll('.thread-av').length,
      threadPrev: [...document.querySelectorAll('.thread-prev')].map((x) => x.textContent.trim().slice(0, 24)),
      pins: document.querySelectorAll('.thread-pin').length,
      groupTags: [...document.querySelectorAll('.tg-tag')].map((x) => x.textContent.trim()),
      othersLabel: document.querySelector('.tgroup-others-h')?.textContent.trim() ?? null,
      othersTeams: document.querySelectorAll('.tgroup-others .tgroup-card').length,
      gnotice: document.querySelector('.gnotice-t')?.textContent.trim().slice(0, 30) ?? null,
      gnoticeHead: document.querySelector('.gnotice-h .k')?.textContent.trim() ?? null,
      moreBtns: document.querySelectorAll('.thread-more').length,
      rowWidth: (() => {
        const row = document.querySelector('.thread-row');
        const rail = document.querySelector('.rail');
        if (!row || !rail) return null;
        return {
          row: Math.round(row.getBoundingClientRect().width),
          rail: Math.round(rail.getBoundingClientRect().width),
        };
      })(),
    }))()`);
    // 群操作菜单：点 ⋯ 应弹出（置顶 / 改名 / 删除一个入口）
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.thread-more');
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const tmenu = await win.webContents.executeJavaScript(`(() => ({
      open: !!document.querySelector('.jobmenu'),
      items: [...document.querySelectorAll('.jobmenu-item')].map((x) => x.textContent.trim()),
    }))()`);
    console.log("GROUPP1_TMENU", JSON.stringify(tmenu));
    writeJson("GROUPP1_TMENU", tmenu);
    // 成员右键 → 查看资料 → 应弹出资料卡（分层）
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.mcard');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 12 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const prof = await win.webContents.executeJavaScript(`(() => {
      const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => x.textContent.trim() === '查看资料');
      if (it) it.click();
      return !!it;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const card = await win.webContents.executeJavaScript(`(() => ({
      card: !!document.querySelector('.mdetail-card'),
      overlay: !!document.querySelector('.mdetail-overlay'),
      secs: [...document.querySelectorAll('.mdetail-sec-h')].map((x) => x.textContent.trim()),
      who: document.querySelector('.mdetail-id b')?.textContent.trim() ?? null,
      rows: [...document.querySelectorAll('.mdetail-row dt')].map((x) => x.textContent.trim()),
    }))()`);
    console.log("GROUPP1_PROFILE", prof, JSON.stringify(card));
    writeJson("GROUPP1_PROFILE", card);
    console.log("GROUPP1", JSON.stringify(info));
    writeJson("GROUPP1", info);
    // 右键一个成员卡 → 菜单
    const opened = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.mcard');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 12 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 450));
    const menu = await win.webContents.executeJavaScript(`(() => ({
      menu: !!document.querySelector('.jobmenu'),
      items: [...document.querySelectorAll('.jobmenu-item')].map((x) => x.textContent.trim()),
      disabled: [...document.querySelectorAll('.jobmenu-item:disabled')].map((x) => x.textContent.trim()),
    }))()`);
    console.log("GROUPP1_MENU", opened, JSON.stringify(menu));
  },
};
