// 走查模式：halt
// 群界面标题栏右侧的「终止任务」（2026-11-15）：第一下变「确认终止」，第二下才真停；
// 停后按钮换成「已终止」，下面一行说明怎么恢复。
module.exports = {
  mode: "halt",
  async run({ win }) {
    const read = () =>
      win.webContents.executeJavaScript(`(() => ({
        btn: document.querySelector('.halt-btn')?.textContent.trim() ?? null,
        state: document.querySelector('.halt-state')?.textContent.trim() ?? null,
        subs: [...document.querySelectorAll('.sheet-head .sheet-sub')].map(x => x.textContent.trim()),
        title: document.querySelector('.sheet-title')?.textContent.trim() ?? null,
      }))()`);

    const before = await read();
    // LYNN_SHOT_STAGE=before：只截"终止任务"按钮本身，不点它
    if (process.env.LYNN_SHOT_STAGE === "before") {
      console.log("HALT", JSON.stringify({ before }, null, 1));
      return;
    }
    const first = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.halt-btn'); if (!b) return null;
      b.click(); return b.textContent.trim();
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    const armed = await read();
    const second = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.halt-btn'); if (!b) return null;
      b.click(); return b.textContent.trim();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const after = await read();

    console.log("HALT", JSON.stringify({ before, first, armed, second, after }, null, 1));
  },
};
