// 走查模式：palette —— 两个视图的语义色是否同一套（2026-11-15）
// 用法：LYNN_PREVIEW_STAGE=console|desk，读当前页面关键元素的 computed 颜色。
// 判定口径：--seal 只给「待你拍板 / 卡住」，--blue 给「进行中 / 已核」，
//          --brass 只给预算/消耗/未核证据，--red 只给打回轮次。
module.exports = {
  mode: "palette",
  async run({ win }) {
    // 值台的工单台账在左栏「工单」页签里（控制台没有这个元素，点了也无副作用）
    await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('.rail-seg-item')].find((x) => (x.textContent || '').includes('工单'));
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 400));

    const info = await win.webContents.executeJavaScript(`(() => {
      const root = getComputedStyle(document.documentElement);
      const fg = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).color : null;
      };
      const bg = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return {
        token: {
          seal: root.getPropertyValue('--seal').trim(),
          blue: root.getPropertyValue('--blue').trim(),
          brass: root.getPropertyValue('--brass').trim(),
          red: root.getPropertyValue('--red').trim(),
        },
        view: document.querySelector('.cs-shell') ? 'console' : 'desk',
        console: {
          readoutStuck: fg('.cs-readout.bad b'),
          sealTone: fg('.cs-seal'),
          sealPhase: document.querySelector('.cs-seal')?.getAttribute('data-phase') ?? null,
          analyzing: document.querySelector('.cs-analyzing') ? fg('.cs-analyzing i') : null,
          taskAlertBg: bg('.cs-task.alert'),
          rejected: document.querySelector('.cs-t-rej.hot') ? fg('.cs-t-rej.hot') : null,
          ticksLive: document.querySelector('.cs-ticks i.live') ? bg('.cs-ticks i.live') : null,
          legendLive: bg('.lg.live'),
        },
        desk: {
          groups: [...document.querySelectorAll('.grp-label')].map((g) => ({
            text: g.textContent.replace(/\\s+/g, ' ').trim(),
            dot: g.querySelector('.dot') ? getComputedStyle(g.querySelector('.dot')).backgroundColor : null,
          })),
          blockedMark: bg('.job[data-status="blocked"] .job-mark'),
          runningMark: bg('.job[data-status="in_progress"] .job-mark'),
          waitChip: bg('.st-wait'),
        },
      };
    })()`);
    console.log("PALETTE", JSON.stringify(info, null, 2));
  },
};
