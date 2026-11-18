// 走查模式：dialogue（群内协作，2026-11-16）
// 成员用 post_message 发进展/结论/疑问；进展与结论只落群，疑问会叫醒风铃；
// 她回答后在群里以她自己的名义说一句。这里核对四件事：
//  1) 发言卡带成员身份（不是系统卡）；2) 徽标分别是 进展/结论/疑问；
//  3) 疑问的标签色与她/普通标签不同（要一眼看见有人在等答复）；
//  4) 风铃的回答落在群里，且正文能看到结论。
module.exports = {
  mode: "dialogue",
  async run({ win, writeJson }) {
    const read = () =>
      win.webContents.executeJavaScript(`(() => {
        const talk = [...document.querySelectorAll('.feed-item.talk')]
          .filter((el) => ['进展', '结论', '疑问', '风险'].includes(el.getAttribute('data-badge') || ''))
          .map((el) => {
            const tag = el.querySelector('.fv-tag');
            return {
              badge: el.getAttribute('data-badge'),
              who: el.querySelector('.fv-name')?.textContent?.trim() ?? null,
              role: el.querySelector('.fv-name')?.getAttribute('title') ?? null,
              tagColor: tag ? getComputedStyle(tag).color : null,
              body: (el.querySelector('.feed-body')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90),
            };
          });
        const answers = [...document.querySelectorAll('.feed-item.lynn')]
          .map((el) => (el.querySelector('.feed-text')?.textContent ?? '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        return {
          talk,
          answer: answers.find((t) => t.includes('算进合计')) ?? null,
          historyRow: Boolean(document.querySelector('.feed-history')),
        };
      })()`);

    let info = await read();
    // 默认只展开"你最近一次说话"之后的往来；夹具里的对话在最后，通常已在屏上
    if (info.talk.length === 0 && info.historyRow) {
      await win.webContents.executeJavaScript(`(() => {
        const b = document.querySelector('.feed-history');
        if (b) b.click();
        return Boolean(b);
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      info = await read();
    }
    writeJson("dialogue", info);
    console.log("DIALOGUE", JSON.stringify(info, null, 1));
  },
};
