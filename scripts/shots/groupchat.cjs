// 走查模式：groupchat
// 由 preview-shot.cjs 的注册表按 process.argv[3] 调用；ctx 提供 win 与 node 侧模块。
module.exports = {
  mode: "groupchat",
  async run({ win, app, fs, path, writeJson, out, W, H }) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const feed = document.querySelector('.feed');
      const box = feed ? feed.getBoundingClientRect() : null;
      const items = [...document.querySelectorAll('.feed-item')];
      const users = items.filter((x) => x.classList.contains('user'));
      const talks = items.filter((x) => x.classList.contains('talk'));
      const u = users[users.length - 1];
      return {
        items: items.length,
        users: users.length,
        talks: talks.length,
        atChips: document.querySelectorAll('.at-chip').length,
      atPending: [...document.querySelectorAll('.at-pending')].map((x) => x.textContent.trim()),
        chipText: [...document.querySelectorAll('.at-chip')].map((x) => x.textContent.trim()),
        talkNames: [...document.querySelectorAll('.feed-item.talk .fv-name')].map((x) => x.textContent.trim()),
        talkRoles: [...document.querySelectorAll('.fv-role')].map((x) => x.textContent.trim()),
        talkAvatars: document.querySelectorAll('.feed-item.talk .fv-who img').length,
        userRightGap: u && box ? Math.round(box.right - u.getBoundingClientRect().right) : null,
        userLeftGap: u && box ? Math.round(u.getBoundingClientRect().left - box.left) : null,
        unknownNotice: [...document.querySelectorAll('.feed-item.system')].map((x) => x.textContent.trim()).filter((t) => t.includes('群里没有')),
      };
    })()`);
    console.log("GROUPCHAT", JSON.stringify(info));
    writeJson("GROUPCHAT", info);
    // @ 补全：输入 "@顾" 应先列群里的人（本群成员排前面），再列文件
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.composer-in');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '@顾');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const pop = await win.webContents.executeJavaScript(`(() => ({
      pop: !!document.querySelector('.mention-pop'),
      items: [...document.querySelectorAll('.mention-item')].map((x) => x.textContent.trim()),
    }))()`);
    console.log("ATPOP", JSON.stringify(pop));
    // 滚到群聊卡（用户 @成员 / 风铃点名 / 成员交付）——默认贴底看不到它们
    await win.webContents.executeJavaScript(
      `(() => { const t=document.querySelector('.feed-item.talk'); if (t) t.scrollIntoView({ block: 'center' }); })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
  },
};
