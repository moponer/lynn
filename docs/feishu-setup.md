# 飞书渠道配置指南

> 2026-11-18。给配置飞书机器人时用。
>
> **先跑自检**：`npm run check:feishu -- --app-id cli_xxx --app-secret yyy`
> 它能自动查出凭据、机器人、权限的问题，剩下的按本文做。

## 一、你需要准备什么

| 东西 | 从哪拿 | 填到哪 |
|---|---|---|
| App ID | open.feishu.cn → 应用 → 凭证与基础信息 | 设置 → IM 渠道 → App ID |
| App Secret | 同上 | 同上（加密落盘） |
| **你自己的 open_id** | 见第 4 节 | 同上 → 允许的用户 open_id |

**注意**：白名单要填的是**你**（使用者）的 open_id，**不是机器人的**。
这两个很容易搞混，而填错了表现是"发消息没反应"。

## 二、飞书后台要做的五件事

按顺序做，漏一步就连不上。

### 1. 启用机器人

```
open.feishu.cn → 你的应用 → 应用功能 → 机器人 → 启用
```

不启用的话，飞书里搜不到你的机器人，也收不到消息。

### 2. 开权限

```
应用功能 → 权限管理 → 搜索并开通
```

| 权限 | 作用 | 必需 |
|---|---|---|
| `im:message` | 收发消息 | ✅ 必须 |
| `im:message:receive_v1` | 接收消息事件 | ✅ 必须 |
| `im:chat:readonly` | 读群信息 | 群聊才要 |
| `im:resource` | 收发图片/文件 | 暂不需要（当前只支持文本） |

### 3. 配事件订阅（关键：选长连接）

```
应用功能 → 事件订阅
```

**订阅方式必须选「长连接」**。

为什么：长连接是**你的程序主动连飞书**，所以本机没有公网 IP 也能收消息。
如果选「Webhook」，飞书要主动访问你的地址——那就需要公网 IP 或内网穿透。

然后添加事件：**接收消息 `im.message.receive_v1`**。

### 4. 发布版本

```
版本管理与发布 → 创建版本 → 申请发布
```

**不发布的话所有配置都不生效**。企业自建应用通常自动通过审核。

### 5. 确认应用状态

回到应用首页，状态应该是「已启用」。如果显示「审核中」，等一会儿或找管理员。

## 三、在 Lynn 里填配置

### 方式一：设置页（推荐）

```
设置 → IM 渠道
├─ App ID: cli_xxxxxxxx
├─ App Secret: 粘贴（会加密存，界面上看不到已存的值）
├─ 允许的用户 open_id: ou_xxxxxxxx（见第 4 节）
├─ ☐ 响应群聊（默认只响应私聊）
└─ ☑ 启用飞书渠道
```

**白名单是必填的**——留空保存不了。原因：飞书消息来自陌生人，
而 Lynn 的成员有文件与命令权限。

### 方式二：命令行
```bash
npm run check:feishu -- --app-id cli_xxx --app-secret yyy
```

它会调 `GET /im/v1/chats` + `GET /im/v1/chats/{id}/members`，
把机器人所在会话的成员列出来，标 `👤` 的就是你（标 `🤖` 的是机器人自己）。

需要 `im:chat:readonly` 权限（读会话信息）。缺了会明确告诉你，
**并且提醒你开完权限要重新发布版本**——不发布不生效。

### 方式三：手改 settings.json

```jsonc
// ~/.lynn/settings.json
{
  "im": {
    "feishu": {
      "appId": "cli_xxxxxxxx",
      "appSecret": { "encrypted": true, "data": "<safeStorage 加密后的 base64>" },
      "allowOpenIds": ["ou_xxxxxxxx"],
      "allowGroup": false,
      "enabled": true
    }
  }
}
```

`appSecret.data` 是 `safeStorage.encryptString()` 的结果再 base64。
**手改时不要写明文**——加密器未注入时内核会拒绝保存明文。

## 四、拿你自己的 open_id

> **2026-11-18 更新**：不再需要"发消息然后翻日志"。
> 应用里点「自检」，它会用官方 API 列出你的 open_id，点「用这个」直接填。
>
> **关键前提**：`open_id` 是**按应用隔离**的——同一个人在你 A 应用下的 open_id
> 与 B 应用下的**不同**。所以从别处抄来的 open_id 一定对不上，
> 表现为日志里 `ignored a message from a sender outside the legacy allowlist`。
> 必须从**这个 app** 查出来的才有效。

### 方式一：自检（推荐）

这是最容易卡住的一步，因为它**必须先把前面都配好**。

```
1. 在飞书里搜你的机器人名字（应用发布后才会出现）
2. 给它发一条消息，比如「在吗」
3. 启动应用：LYNN_IM_BRIDGE=1 npm start
4. 看日志，搜 feishu_incoming：
     [im] feishu_incoming {"sender":"ou_abc123...","chat":"oc_...","group":false,"preview":"在吗"}
                              ^^^^^^^^^^^^^ 这个就是你的 open_id
5. 把它填进设置页的白名单
```

**如果日志里是 `ignored a message from a sender outside the legacy allowlist`**，
说明消息**已经进来了**，只是白名单里的 open_id 对不上。最常见的原因是
open_id 来自另一个应用（按应用隔离）。用上面的「自检」重新查一次。

**如果日志里没有 `feishu_incoming`**，说明消息没进来。按这个顺序查：

| 查什么 | 怎么看 |
|---|---|
| 渠道起来了吗 | 日志搜 `[im] 飞书：connected` |
| 事件订阅配了吗 | 飞书后台 → 事件订阅 → 有没有 `im.message.receive_v1` |
| 选的是长连接吗 | 同上，订阅方式 |
| 应用发布了吗 | 版本管理与发布 |
| 机器人启用了吗 | 应用功能 → 机器人 |

**如果有 `feishu_ignored`**，说明消息进来了但被闸门挡了：

```
[im] feishu_ignored {"sender":"ou_xxx","reason":"白名单为空——在设置里加上允许的用户 open_id"}
```

`reason` 会直接告诉你原因。

## 五、启动应用

```bash
# Windows PowerShell
$env:LYNN_IM_BRIDGE = "1"; npm start

# bash
LYNN_IM_BRIDGE=1 npm start
```

启动后日志里应该看到：

```
[im] 端点已启动：http://127.0.0.1:xxxxx
[im] token: <64 位>
[im] 飞书：connecting
[im] 飞书：connected
[im] 飞书渠道已连接
```

## 六、出问题时

### 先跑自检

```bash
npm run check:feishu -- --app-id cli_xxx --app-secret yyy
```

它会告诉你：

- `appSecret 不对` → 去重置（重置后旧的立刻失效）
- `appId 不存在` → 复制漏字符了
- `读不到机器人信息` → 机器人能力没开
- 网络失败 → 检查能不能访问 `open.feishu.cn`

### 常见错误对照

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `飞书渠道的白名单为空` | 白名单没填 | 填一个 open_id |
| `飞书 SDK 没装` | 依赖没装 | `npm install @larksuiteoapi/node-sdk` |
| 日志有 `connected` 但发消息没反应 | 事件订阅没配 | 后台加 `im.message.receive_v1` |
| 日志完全没有 `feishu_*` | 渠道没启用 | 设置页勾「启用飞书渠道」 |
| `feishu_ignored` 说不在白名单 | open_id 填错了 | 确认是**你**的，不是机器人的 |
| 回复很慢 | 一轮对话本身慢 | 正常，派单任务可能几分钟 |

## 七、安全提醒

| 项 | 说明 |
|---|---|
| **App Secret 等于密码** | 泄露后别人能冒充你的应用。不要贴到聊天/issue 里 |
| **白名单不是可选项** | 留空时渠道拒绝启动，这是刻意的 |
| **群聊默认关** | 群里任何人都能 @ 机器人，所以默认只在私聊响应 |
| **凭据加密存盘** | 走 safeStorage，与模型 API Key 同一套；界面上看不到已存的值 |
| **端点只监听本机** | `127.0.0.1` + 随机 token，局域网连不上 |

## 八、当前能力边界

**支持**：私聊/群聊的**文本**消息 → 跑一轮 → 回文本。

**不支持**（本轮没做）：

| 能力 | 说明 |
|---|---|
| 图片/文件 | 收到会被忽略（`parseIncoming` 返回 null） |
| 飞书卡片 | 回复是纯文本，不是卡片 |
| 流式输出 | 等整轮跑完才回，不是逐字出 |
| 斜杠命令 | 没有 |
| 群历史 | 没有 |

要做这些，参考 `src/main/im-feishu.ts` 里的 `onMessage`——它已经是完整的
"收 → 处理 → 回"闭环，加能力是在这个闭环里插东西。
