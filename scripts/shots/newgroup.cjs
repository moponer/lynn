// 走查模式：newgroup —— 新建群后，右栏不该挂着别群的「等你拍板」。
// 夹具的裁决都带 threadId=t-main；假桥 session.new 会真的切到新群，
// 由渲染层按当前群过滤，跟真内核的快照口径一致。
module.exports = {
  mode: 'newgroup',
  async run({ win, writeJson }) {
    const read = () =>
      win.webContents.executeJavaScript(`(() => ({
        firstGroup: (document.querySelector('.thread-row')?.textContent ?? '').trim().slice(0, 40),
        sealCount: document.querySelectorAll('.sealcard').length,
        sealText: (document.querySelector('.seal-slot')?.textContent ?? '').trim().slice(0, 80),
        notice: (document.querySelector('.gnotice-t')?.textContent ?? '').trim().slice(0, 30),
        rosterNote: (document.querySelector('.right .note')?.textContent ?? '').trim().slice(0, 40),
      }))()`);
    const before = await read();
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.icon-btn.rail-new'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 1100));
    const after = await read();
    const result = {
      clicked,
      before,
      after,
      ok: clicked && before.sealCount > 0 && after.sealCount === 0,
    };
    console.log('NEWGROUP', JSON.stringify(result));
    writeJson('newgroup', result);
  },
};
