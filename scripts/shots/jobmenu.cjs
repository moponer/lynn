// 走查模式：jobmenu
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
// 2026-11-15：左栏默认落在「群」，先切「工单」再右键 —— 菜单分组（小节帽/发丝线/危险段）在这里看。
module.exports = {
  mode: "jobmenu",
  async run({ win, fs, path, out }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('.rail-seg-item')].find((x) => (x.textContent || '').includes('工单'));
      if (b) b.click();
      return !!b;
    })()`);
    await wait(450);
    const ok = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.job');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 24 }));
      return true;
    })()`);
    await wait(450);
    const info = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.jobmenu');
      if (!m) return null;
      const items = [...m.querySelectorAll('.jobmenu-item')];
      return {
        w: Math.round(m.getBoundingClientRect().width),
        caps: [...m.querySelectorAll('.jobmenu-cap')].map((x) => x.textContent.trim()),
        seps: m.querySelectorAll('.jobmenu-sep').length,
        items: items.map((x) => ({
          t: x.textContent.trim().slice(0, 18),
          lead: x.classList.contains('lead'),
          danger: x.classList.contains('danger'),
        })),
        dangerIsLast: items.length ? items[items.length - 1].classList.contains('danger') : null,
        focused: document.activeElement?.textContent?.trim().slice(0, 18) ?? null,
        // 视口夹取：菜单不能探出窗口底边
        bottomGap: Math.round(window.innerHeight - m.getBoundingClientRect().bottom),
      };
    })()`);
    console.log("JOBMENU", ok, JSON.stringify(info, null, 1));
    // 1600 宽的全图里菜单字太小看不清分组与字重：放大 2 倍单独存一份
    const rect = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.jobmenu');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { x: Math.floor(r.x) - 10, y: Math.floor(r.y) - 10, width: Math.ceil(r.width) + 20, height: Math.ceil(r.height) + 20 };
    })()`);
    if (rect) {
      win.showInactive();
      await wait(300);
      const shot = await win.webContents.capturePage(rect);
      const big = shot.resize({ width: rect.width * 2 });
      const cropPath = path.join(path.dirname(out), path.basename(out, path.extname(out)) + "-crop.png");
      fs.writeFileSync(cropPath, big.toPNG());
      console.log("SHOT_CROP", cropPath, big.getSize());
    }
  },
};
