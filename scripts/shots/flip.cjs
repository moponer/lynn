// 走查模式：flip
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "flip",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(async () => {
      const row = [...document.querySelectorAll('.mcard')].pop() || [...document.querySelectorAll('.thread-row')].pop();
      if (!row) return { row: false };
      const r = row.getBoundingClientRect();
      const y = Math.min(window.innerHeight - 4, r.bottom); // 模拟在底部附近右键
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 8, clientY: y }));
      await new Promise((res) => setTimeout(res, 80)); // 等 React 渲染菜单一帧 + layout effect 测高
      const menu = document.querySelector('.jobmenu');
      if (!menu) return { opened: false, clickedY: Math.round(y) };
      const m = menu.getBoundingClientRect();
      return {
        opened: true,
        clickedY: Math.round(y),
        menuTop: Math.round(m.top),
        menuBottom: Math.round(m.bottom),
        vh: window.innerHeight,
        flippedUp: m.bottom <= y + 4,
        withinViewport: m.top >= 0 && m.bottom <= window.innerHeight,
        headerIcon: !!menu.querySelector('.jobmenu-h .ic'),
        itemIcons: menu.querySelectorAll('.jobmenu-item .ic').length,
      };
    })()`);
    console.log("FLIP", JSON.stringify(info));
  },
};
