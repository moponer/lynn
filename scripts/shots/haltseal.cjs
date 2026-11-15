// 走查模式：haltseal（2026-11-15）
// 用户实机：按了「终止任务」之后，右栏那枚「等你拍板 / 验收归档」还赖着不走。
// 这里读三件事：终止前印章在不在、终止后印章是否整块消失、台账是否多出「已终止」组。
// 夹具：LYNN_PREVIEW_SEAL=1（本群挂一张 in_review + reviewer=user 的单）。
module.exports = {
  mode: "haltseal",
  async run({ win }) {
    const js = (expr) => win.webContents.executeJavaScript(expr);
    const read = () =>
      js(`(() => ({
        sealHead: document.querySelector('.seal-slot .sealcard-h .k')?.textContent.trim() ?? null,
        sealBtns: [...document.querySelectorAll('.seal-slot .btn')].map(b => b.textContent.trim()),
        groups: [...document.querySelectorAll('.grp-label')].map(x => x.textContent.trim()),
        stages: [...document.querySelectorAll('.job-stage')].map(x => x.textContent.trim()),
        haltState: document.querySelector('.halt-state')?.textContent.trim() ?? null,
      }))()`);

    // 台账分组在「工单」页签里
    await js(`(() => {
      const b = [...document.querySelectorAll('.rail-seg-item')].find(x => /工单/.test(x.textContent || ''));
      if (b) b.click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const before = await read();

    // 终止任务：第一下变「确认终止」，第二下才真停
    await js(`(() => { document.querySelector('.halt-btn')?.click(); })()`);
    await new Promise((r) => setTimeout(r, 200));
    await js(`(() => { document.querySelector('.halt-btn')?.click(); })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await read();

    console.log("HALTSEAL", JSON.stringify({ before, after }, null, 1));
  },
};
