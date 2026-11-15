// 走查模式：askcard
// 统一后的菜单分组与确认卡片（2026-11-15）：
//   ① 群 ⋯ 菜单：小节帽 / 发丝线 / 危险项是否单独成段且排最后；
//   ② 点「删除群」→ 同一张确认卡片：标题 / 说明 / 警示 / 按钮位置与强弱；
//   ③ Esc 能收起（危险动作默认聚焦"取消"）。
module.exports = {
  mode: "askcard",
  async run({ win }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const openMenu = () =>
      win.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.thread-line');
        const more = row && row.querySelector('.thread-more');
        if (!more) return false;
        more.click();
        return true;
      })()`);

    const opened = await openMenu();
    await wait(350);
    const menu = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.jobmenu');
      if (!m) return null;
      const items = [...m.querySelectorAll('.jobmenu-item')];
      return {
        w: Math.round(m.getBoundingClientRect().width),
        caps: [...m.querySelectorAll('.jobmenu-cap')].map((x) => x.textContent.trim()),
        seps: m.querySelectorAll('.jobmenu-sep').length,
        items: items.map((x) => ({ t: x.textContent.trim(), danger: x.classList.contains('danger'), lead: x.classList.contains('lead') })),
        dangerIsLast: items.length ? items[items.length - 1].classList.contains('danger') : null,
        focused: document.activeElement?.textContent?.trim() ?? null,
      };
    })()`);
    console.log("ASKMENU", JSON.stringify(menu));

    const clicked = await win.webContents.executeJavaScript(`(() => {
      const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => x.textContent.includes('删除'));
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await wait(450);
    const card = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.ask-card');
      if (!c) return null;
      return {
        clicked: ${JSON.stringify(true)},
        opened: ${JSON.stringify(opened)},
        clickDelete: ${JSON.stringify(clicked)},
        tone: c.dataset.tone,
        title: c.querySelector('.ask-title')?.textContent.trim() ?? null,
        body: c.querySelector('.ask-body')?.textContent.trim() ?? null,
        note: c.querySelector('.ask-note')?.textContent.trim() ?? null,
        btns: [...c.querySelectorAll('.ask-btn')].map((b) => ({
          t: b.textContent.trim(),
          cls: b.className.replace('ask-btn ', ''),
          bg: getComputedStyle(b).backgroundColor,
          color: getComputedStyle(b).color,
        })),
        focused: document.activeElement?.textContent?.trim() ?? null,
        w: Math.round(c.getBoundingClientRect().width),
        // 按钮是否都在同一行、右对齐
        actsRow: (() => {
          const acts = c.querySelector('.ask-acts');
          const r = acts.getBoundingClientRect();
          const bs = [...acts.querySelectorAll('.ask-btn')].map((b) => b.getBoundingClientRect());
          return { sameRow: bs.every((b) => Math.abs(b.top - bs[0].top) < 2), rightAligned: Math.abs(r.right - bs[bs.length - 1].right) < 2 };
        })(),
      };
    })()`);
    console.log("ASKCARD", JSON.stringify(card, null, 1));

    // Esc = 取消（焦点在"取消"按钮上，keydown 冒泡到卡片）
    const escClosed = await win.webContents.executeJavaScript(`(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    await wait(300);
    console.log("ASKESC", escClosed, await win.webContents.executeJavaScript(`!document.querySelector('.ask-card')`));

    // 给截图留一张"卡片开着"的状态
    const reopened = await openMenu();
    await wait(350);
    const menuThen = await win.webContents.executeJavaScript(`!!document.querySelector('.jobmenu')`);
    const clickedAgain = await win.webContents.executeJavaScript(`(() => {
      const it = [...document.querySelectorAll('.jobmenu-item')].find((x) => x.textContent.includes('删除'));
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await wait(500);
    const cardThen = await win.webContents.executeJavaScript(`document.querySelector('.ask-card .ask-title')?.textContent.trim() ?? null`);
    console.log("ASKREOPEN", { reopened, menuThen, clickedAgain, cardThen });
    // 明/暗留证：preview-shot 的 argv[4] 主题参数会在走查后 location.reload()，把卡片冲掉，
    // 这里直接切 html[data-mode]（不重载页面）。LYNN_SHOT_MODE=light|dark
    const shotMode = process.env.LYNN_SHOT_MODE;
    if (shotMode === "light" || shotMode === "dark") {
      await win.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-mode', ${JSON.stringify(shotMode)})`,
      );
      await wait(250);
    }
  },
};
