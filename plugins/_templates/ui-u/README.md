# 示例界面（U 档模板）

演示**占一个 UI 卡槽**的插件。这个模板占的是 `status.bar`（顶栏状态条）。

## 运行方式

`ui.html` 会被塞进 `sandbox="allow-scripts"` 的 **iframe**：

- 拿不到宿主的 DOM、cookie、localStorage；
- 只能通过 `postMessage` 与宿主说话；
- 没有 `allow-same-origin`，所以**访问 `parent` 的 DOM 会抛错**（发消息可以）。

## 通信契约（只有两条）

**收**（宿主 → 你）：
```js
{ lynn: true, type: "init", plugin: "lynn.template.ui", theme: { desk, sheet, ink } }
```

**发**（你 → 宿主）：
```js
parent.postMessage({ lynn: true, type: "action", label: "点了什么" }, "*");
parent.postMessage({ lynn: true, type: "resize", height: 28 }, "*");
```

## 可用卡槽（8 个）

`theme.tokens` · `stage.view` · `card.renderer` · `avatar.driver` ·
`sidebar.item` · `settings.section` · `status.bar` · `composer.action`

（`stage.console` 只许官方插件——它是内置视图注册表的入口。）

## 三条禁令

| 不要 | 为什么 |
|---|---|
| 访问 `parent` / `top` 的 DOM | 没有 `allow-same-origin`，会抛错 |
| 加载外部脚本 | CSP 会拦 |
| 写死颜色 | 换主题时不跟着变；用 `init` 下发的 `theme` 令牌 |

## 错误隔离

你的 `ui.html` 崩了（脚本抛错、渲染失败），宿主会在卡槽位置显示一张
「插件『xxx』出错，已隔离」的卡片，**其它界面照常工作**。
