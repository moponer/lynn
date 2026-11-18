// 走查模式：capcenter
// 能力中心（2026-11-15）：五个分段 + 统一开关 + 外部应用配置表单。
// 分段用 LYNN_SHOT_STAGE 指定（plugins|mcp|skills|auto|apps），默认 apps（信息量最大）。
module.exports = {
  mode: "capcenter",
  async run({ win, fs, out }) {
    const stage = process.env.LYNN_SHOT_STAGE || "apps";
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const opened = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.ghost-btn')].find(x=>(x.textContent||'').includes('我的风铃')); if (b) b.click(); return !!b; })()`,
    );
    await wait(700);
    const navOk = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.sf-nav-item')].find(x=>(x.textContent||'').includes('能力中心')); if (b) b.click(); return !!b; })()`,
    );
    await wait(900);

    const labelOf = { plugins: "插件", mcp: "MCP", skills: "技能", auto: "自动化", apps: "外部应用" }[stage];
    // 按钮文本现在带计数（「技能2」），所以用包含而不是全等匹配（2026-11-16）
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('.cap-seg-btn')].find(x=>(x.textContent||'').includes(${JSON.stringify(labelOf)})); if (b) b.click(); return !!b; })()`,
    );
    await wait(800);

    // 外部应用：展开第一张卡的配置，看字段与开关是否都在
    let expanded = null;
    if (stage === "apps") {
      expanded = await win.webContents.executeJavaScript(`(() => {
        const card = [...document.querySelectorAll('.cap-app')].find((c) => !c.querySelector('.cap-form'));
        if (!card) return { ok: false };
        const btn = [...card.querySelectorAll('.sf-btn')].find((b) => (b.textContent || '').includes('配置'));
        if (!btn) return { ok: false, why: "no-config-btn" };
        btn.click();
        return { ok: true, name: card.querySelector('b')?.textContent.trim() ?? null };
      })()`);
      await wait(600);
    }

    const info = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('.sf-pane h3')?.textContent.trim() ?? null,
      stat: document.querySelector('.cap-seg')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      segs: [...document.querySelectorAll('.cap-seg-btn')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on') })),
      // 技能行：描述与工具面是否收成一行、工具清单是否已折叠成件数
      skillRows: [...document.querySelectorAll('.sk-meta')].map((m) => {
        const d = m.querySelector('.sk-desc');
        return {
          desc: d ? d.textContent.trim().slice(0, 24) : null,
          descClipped: d ? d.scrollWidth > d.clientWidth + 1 : null,
          tools: m.querySelector('.sk-tools')?.textContent.trim() ?? null,
          h: Math.round(m.getBoundingClientRect().height),
        };
      }),
      groups: [...document.querySelectorAll('.sf-group-head b')].map((b) => b.textContent.trim()),
      rows: document.querySelectorAll('.sf-row').length,
      switches: [...document.querySelectorAll('.cap-sw')].map((s) => ({ on: s.classList.contains('on'), w: Math.round(s.getBoundingClientRect().width) })),
      presets: document.querySelectorAll('.sf-market-card').length,
      presetRects: [...document.querySelectorAll('.sf-market-card')].map((c) => {
        const r = c.getBoundingClientRect();
        const btn = c.querySelector('.sf-market-actions .sf-btn');
        const br = btn ? btn.getBoundingClientRect() : null;
        return {
          name: (c.querySelector('b')?.textContent || '').trim(),
          h: Math.round(r.height),
          btnBottom: br ? Math.round(br.bottom - r.top) : null,
          overflow: br ? Math.round(br.bottom - r.bottom) : null,
        };
      }),
      apps: [...document.querySelectorAll('.cap-app')].map((c) => ({
        name: c.querySelector('b')?.textContent.trim() ?? null,
        cat: c.querySelector('.cap-cat')?.textContent.trim() ?? null,
        badge: c.querySelector('.sf-badge')?.textContent.trim() ?? null,
        glyph: c.querySelector('.cap-glyph')?.className ?? null,
        hasForm: !!c.querySelector('.cap-form'),
      })),
      fields: [...document.querySelectorAll('.cap-field .sf-label')].map((x) => x.textContent.trim()),
      inputTypes: [...document.querySelectorAll('.cap-field input')].map((x) => x.type),
      acts: [...document.querySelectorAll('.cap-app .cap-app-acts .sf-btn')].map((x) => x.textContent.trim()),
      msg: document.querySelector('.sf-result')?.textContent.trim() ?? null,
      glyphColor: (() => { const g = document.querySelector('.cap-glyph'); return g ? getComputedStyle(g).color : null; })(),
    }))()`);

    console.log("CAPCENTER", JSON.stringify({ opened, navOk, stage, clicked, expanded, info }, null, 1));

    // 2 倍裁剪「已装/可预装」那一段：全图里小字读不清，细节要靠放大图确认
    const rect = await win.webContents.executeJavaScript(`(() => {
      const heads = [...document.querySelectorAll('.sf-group')];
      // 技能段优先截「已发现的技能」（2026-11-16：技能行改版要单独看清楚）
      const g = heads.find((x) => (x.querySelector('.sf-group-head b')?.textContent || '').includes('已发现'))
        || heads.find((x) => (x.querySelector('.sf-group-head b')?.textContent || '').includes('可预装'))
        || heads.find((x) => (x.querySelector('.sf-group-head b')?.textContent || '').includes('已装'));
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.min(Math.round(r.height), 460) };
    })()`);
    if (rect && rect.width > 40) {
      // 隐藏窗口里 capturePage(rect) 会拿到上一帧（实测截到的是插件段，不是当前段）：
      // 先显形并强制重绘一次，同 usageboard 的做法
      win.showInactive();
      await wait(300);
      win.webContents.invalidate();
      await wait(250);
      const img = await win.webContents.capturePage(rect);
      fs.writeFileSync(String(out).replace(/\.png$/, "-crop.png"), img.resize({ width: rect.width * 2 }).toPNG());
    }
  },
};
