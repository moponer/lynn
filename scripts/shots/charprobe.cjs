// 走查模式：charprobe
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "charprobe",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/上回合|历史|展开/.test(x.textContent||'')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('.feed-scroll, .sheet-body');
      if (box) box.scrollTop = box.scrollHeight;
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const info = await win.webContents.executeJavaScript(`(() => {
      const list = [...document.querySelectorAll('.mcard-char')].map(el => ({
        ch: el.textContent.trim(),
        w: Math.round(el.getBoundingClientRect().width),
        fs: getComputedStyle(el).fontSize,
        bg: getComputedStyle(el).backgroundColor,
      }));
      const seen = new Map();
      for (const x of list) { const k = x.w + ':' + x.ch + ':' + x.fs; if (!seen.has(k)) seen.set(k, x); }
      const root = getComputedStyle(document.documentElement);
      return {
        samples: [...seen.values()].slice(0, 10),
        total: list.length,
        mode: document.documentElement.dataset.mode,
        theme: document.documentElement.dataset.theme,
        sheet2: root.getPropertyValue("--sheet-2").trim(),
        ink: root.getPropertyValue("--ink").trim(),
      };
    })()`);
    console.log("CHARPROBE", JSON.stringify(info));
  },
};
