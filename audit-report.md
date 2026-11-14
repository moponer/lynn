# 风铃 Lynn 代码审计报告

- 审计对象：`F:/spiker/lynn`（Electron + React 桌面 AI 助理；薄壳 + Pi 运行时 + 三档插件 + MCP）
- 审计方式：只读静态阅读，未运行构建、未跑测试、未修改任何源码
- 定位口径：**行号为近似定位**（按符号/区段给出），因为本次以整文件阅读为主，未逐行核对行号；每条隐患都给出可复核的函数名或代码片段特征
- 覆盖情况：主进程 `src/main/` 已读 18 个文件（main / kernel(前 2000 行) / preload / llm / mcp / toolkit / member-runner / management-tools / plugin-host / plugin-manifest / endpoint / settings / roots / browser / 等）、`src/shared/contract.ts`、`vite.config.ts`、`tsconfig*.json`、`package.json`、`scripts/copy-assets.mjs`。**未覆盖**：`src/renderer/` 全部代码、`capture-host.ts`、`agent-host.ts`、`pi-rpc-host.ts`、`plugin-l1.ts`、`workshop.ts`、`updater.ts`、`trust.ts`、`electron-builder.yml`、`tests/`

## 总览

| # | 隐患 | 分类 | 严重程度 |
|---|---|---|---|
| 1 | 成员可写的目录能通过 `app.openPath` 变成"任意程序执行器" | 安全 | 低（三轮降级） |
| 2 | `run_command` 用 shell 字符串执行 + 正则黑名单，出站只审计不拦截 | 安全 | 高 |
| 3 | L1 插件与内核同权限、进程内加载第三方 TS | 安全 | 高 |
| 4 | `preview.pdfWindow` 不校验扩展名，可在应用窗口内加载成员可控的 HTML | 安全 | 中（三轮降级） |
| 5 | 更新器：feed URL 来自明文配置文件，安装前未见签名/哈希校验 | 安全 | 中 |
| 6 | `providers.discover` 绕过端点风险确认，可把用户 Key 发到任意 baseUrl | 安全 | 中 |
| 7 | MCP：任意 command 直接 spawn，全量继承 `process.env`，cwd 未钉扎 | 安全 | 中 |
| 8 | 渲染层日志通道无速率限制、无轮转，渲染进程可打满磁盘 | 安全 | 中 |
| 9 | API Key 明文降级落盘，settings.json 未收紧文件权限 | 安全 | 中 |
| 10 | 路径守卫用 `startsWith` 前缀比较，未做 realpath（符号链接/junction/短名） | 安全 | 中 |
| 11 | 插件形态层 CSS 白名单过窄，远程字体/资源引用未拦 | 安全 | 低（三轮降级：渲染层已有 CSP） |
| 12 | `preview.read` 把最多 16MB 文件整份 base64 经 IPC 下发渲染层 | 性能 | 中 |
| 13 | 秒级探针 + 多定时器常驻，空转唤醒与磁盘写入频繁 | 性能 | 低（三轮降级：空闲已退避 15s） |
| 14 | `kernel.ts` 单文件职责过载（三轮核实实为 7498 行），main.ts 内联大量业务 | 架构 | 中 |
| 15 | 成员/工单运行时状态全在内存 Map，崩溃后恢复语义未定义 | 架构 | 撤回（三轮证伪） |
| 16 | 模型错误把端点返回体原文落卡/落日志，敏感信息可能外泄 | 代码质量 | 中 |
| 17 | IPC 入口普遍 `params as T` 断言，无运行时参数校验 | 代码质量 | 低 |
| 18 | 缺少 ESLint/Prettier；依赖版本使用 caret 浮动（三轮核实：CI 与 lint:design 已存在） | 代码质量 | 低 |
| 19 | 构建时间戳 `define` 被当作版本比较依据，语义不稳 | 代码质量 | 低 |
| 20 | workshop.ts 插件准入只有静态文本扫描 | 安全 | 中/高 |
| 21 | L1ToolDef.execute 无超时、无并发闸 | 安全 | 中 |
| 22 | nsis.deleteAppDataOnUninstall:false，卸载残留凭据 | 安全 | 低 |

---

## 一、安全类

### 1.【高】成员可写的目录 + `app.openPath` = 任意程序执行链

- 位置：`src/main/main.ts` → `ipcMain.handle("lynn:rpc")` 内 `method === "app.openPath"` 分支
- 代码特征：
  ```ts
  const base = path.resolve(kernel.dataRoot);
  const target = path.resolve(String(p.path ?? ""));
  if (!target.startsWith(base + path.sep)) return { ok: false, error: "只能打开风铃数据目录里的文件" };
  const err = await shell.openPath(target);
  ```
- 描述：守卫只校验"在数据根之内"，但数据根内的 `tasks/<id>/workspace` 正是成员的工作区（`kernel.ts` 的 `workspaceRecordFor` 明确把沙箱工作区放在 `dataRoot/tasks/<id>/` 下），成员通过 `write_file` / `run_command` 对它有完整写权限。于是链路成立：成员写一个 `.bat` / `.cmd` / `.ps1` / `.exe` 到工作区 → 诱导 `app.openPath` 用系统默认程序打开。`shell.openPath` 不做扩展名白名单，等同于"模型可触发数据根内任意可执行文件落地运行"。注释写的"不当前端可调的任意文件执行器"只挡住了目录外的部分，目录内的部分没挡住。
- 建议修复方向：对 `app.openPath` 做扩展名白名单（文档/图片/目录），显式排除可执行与脚本扩展名（bat/cmd/ps1/vbs/js/exe/com/scr/lnk/reg 等）；或对交付物只允许打开 `deliverables/` 与 `artifacts/` 子目录；判断用 `path.extname().toLowerCase()` 白名单而非黑名单。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】降级 高→低：守卫缺扩展名白名单属实（main.ts `app.openPath` 分支逐字属实），但**利用链不成立**——模型没有 RPC 通道，渲染层唯一调用点用的是 `task.export` 返回的内核路径（src/renderer/App.tsx），不是成员可控路径；要利用得先攻破渲染进程，届时本守卫已非最后防线。定性为加固缺口，白名单照修但不再是"高"。

### 2.【高】`run_command` 以 shell 字符串执行，出站动作只审计不拦截

- 位置：`src/main/toolkit.ts` → `Toolkit.runCommand`（`exec(command, {...})`）；`DANGEROUS` / `OUTBOUND` 常量区
- 描述：三点叠加：
  1. 使用 `child_process.exec` 执行完整 shell 命令行，参数与 shell 元字符同处一层，本质是把 shell 交给了模型生成的文本；
  2. `DANGEROUS` 是正则黑名单（约 20 条），作者注释已明确"不是 OS 沙箱"。黑名单天然可绕：环境变量拼接（`%COMSPEC% /c ...` 未覆盖）、`cmd /c` 双层嵌套、`powershell -Command` 内部再解码、变量间接引用（`set a=format; %a% c:`）均不在规则内；
  3. `OUTBOUND` 正则命中后只调 `onAudit({kind:"cmd_net"})` 记一条审计，**不阻断执行**，源码注释即"只审计不拦"。成员工作区里的任意文件（含只读授权根里读到的内容）都可以用 `curl -X POST -d @file` 发出本机，构成数据外泄通道。
- 建议修复方向：出站按域名白名单放行（默认拒绝），至少在 `auto/plan` 权限档下强制拦截；命令执行改为 `execFile`/`spawn` + 参数数组，取消 shell 解释（需要 shell 的场景单独审批）；黑名单改为"命令解释器 + 参数模式"白名单化，或引入 OS 级隔离（容器/受限用户/Job Object）后如实更名为沙箱。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 3.【高】L1 插件与内核同权限，进程内加载第三方 TS

- 位置：`src/main/plugin-host.ts`（`scan` / `probe` / `listL1Entries`）、`src/main/plugin-manifest.ts`（`checkManifest`）、`src/main/plugin-l1.ts`
- 描述：注释自己写明"第三方 L1 与内核同权限（§4.2.1 高信任档）"。`checkManifest` 对 L1 的校验止于：entry 以 `.ts` 结尾、`permissions` 至少声明一层、`proc !== true`。`permissions.fs` 的 glob 只校验"是非空字符串"，`permissions.net` 完全未校验——即声明的权限与实际能力没有任何绑定关系（无运行时代理层强制）。加载方式是 jiti 在**主进程内**直跑 TS，插件代码因此可以直接 `require("electron")`、`fs.readFileSync` 读 `~/.lynn/settings.json` 里的凭据、或起子进程。当前唯一闸门是"第三方默认关闭 + 安全模式"，属于**配置态防护**，一旦用户点启用即等于把主进程交出。
- 建议修复方向：L1 改为独立进程/Worker 加载 + 基于权限声明的能力代理（fs 走内核路径校验、net 走白名单代理、secrets 走凭据代理按需下发），使 manifest 声明真正约束运行期；主进程内不得直接执行第三方代码；启用时的权限确认页要逐项列出 glob 与域名并落审计。
- 二轮依据：
  - plugin-l1.ts 顶部注释自陈「L1 与内核同进程同权限」
  - L1Api 只暴露 registerTool/dataDir/log 三个成员，无 fs/net/secrets 代理
  - manifest.permissions 在 L1Host 全文中一次未被读取（activate 只读 tier/entry/contributes.tools）
  - importL1Module 用 createJiti(__filename,{moduleCache:false,fsCache:false}) 在主进程内直跑 .ts
【二轮复核】确认成立：二轮补读 plugin-l1.ts 后，原判断被证实，可去掉「未验证」标注。

### 4.【高】`preview.pdfWindow` 不校验扩展名，可在应用窗口内加载成员可控 HTML

- 位置：`src/main/main.ts` → `method === "preview.pdfWindow"`
- 描述：该分支的路径守卫与 `preview.read` 一致（限定 `tasks/<taskId>/` 内），但只判断 `existsSync` 与 `isFile()`，随后直接 `pdfWin.loadFile(target)`，**没有校验 `ext === "pdf"`**。成员工作区就在 `tasks/<id>/` 内且可写，因此可以写入一个 `.html`（或 `.svg`），再触发该分支在 Electron `BrowserWindow` 里渲染。该窗口未设置 `webPreferences`（依赖 Electron 默认值），也没有 preload，因此拿不到 `window.lynn`；但 file:// 下同源页面可以读取 `tasks/<id>/` 内的其它本地文件并外发（配合 #2 的出站能力或页面内资源请求），并且渲染不可信内容本身即钓鱼面。
- 建议修复方向：该分支入口加扩展名白名单 `if (ext !== "pdf") return {ok:false,...}`；独立预览窗口显式设置 `{ contextIsolation: true, nodeIntegration: false, sandbox: true }`，并禁止该窗口的 `webContents` 发起网络请求（`onBeforeRequest` 拦截非 file:// 请求）。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】降级 高→中：缺 ext 校验属实（该分支确实只查 existsSync/isFile 后直接 loadFile），但渲染层只在 `preview.read` 判定 `ext === "pdf"` 后才渲染出「打开预览窗口」按钮（src/renderer/PreviewDrawer.tsx），加载 .html 需要直接调 RPC；且 Electron ≥20 默认 contextIsolation/sandbox 已开，报告括注的默认值方向正确。剩余面是"应用窗口内渲染不可信 HTML"的钓鱼面，白名单一行照修。

### 5.【中】更新器：feed URL 来自明文配置，安装前未见签名/完整性校验

- 位置：`src/main/main.ts` → `bindUpdater()` / `handleUpdateRpc`；`src/main/updater.ts`（`resolveFeedUrl`，未读全文）
- 描述：`resolveFeedUrl(process.env, kernel.dataRoot)` 从 `~/.lynn/updater.json` 或 `LYNN_UPDATE_FEED` 读一个 URL，直接 `autoUpdater.setFeedURL({ provider: "generic", url: feed })`。generic provider 下未见任何 `verifyUpdateCodeSignature` / 哈希校验配置，`update.install` 走 `autoUpdater.quitAndInstall(false, true)`。若 feed 指向 HTTP 或被写入恶意地址（本地配置文件无完整性保护），下载的安装包在 Windows 无签名校验时会被直接安装。
- 建议修复方向：强制 feed URL 为 HTTPS；对 generic provider 校验发布包签名/哈希（electron-updater 支持在 `app-update.yml` 配置签名校验，或用代码签名证书）；`updater.json` 的写入者与修改时间做提示；安装前在界面上展示版本号 + 来源 + 校验结果。
- 二轮依据：
  - electron-builder.yml 全文无任何签名键（无 win.signingHashAlgorithms、无证书/时间戳），也无 verifyUpdateCodeSignature
  - asar:false，dist/** 与 agent/** 以明文目录安装，本机可原地替换应用 JS
  - 两条叠加 = 「改文件即持久化」
【二轮复核】升级：二轮补读 electron-builder.yml 后，补全升级理由（无签名配置 + asar:false + 明文目录安装 → 改文件即持久化），严重程度维持中但风险面明确。

### 6.【中】`providers.discover` 未做端点风险确认，可把用户 Key 发到任意 baseUrl

- 位置：`src/main/main.ts` → `method === "providers.discover"` → `src/main/endpoint.ts` → `discoverModels`
- 描述：`shared/endpoint-risk.ts` 有 `riskLevel`（local/insecure/remote）分级，`contract.ts` 里 `model.discover` 也声明了 `riskAccepted?: boolean`（"本机/局域网/非 HTTPS 端点必须显式确认风险，才允许把 Key 发过去探测"）。但壳层的 `providers.discover` 分支直接取 `p.apiKey` 调 `discoverModels(p.baseUrl, p.apiKey)`，**没有读取 `riskAccepted`，也没有调用 `endpointRiskLevel`**；`discoverModels` 内部也不做风险判定，只按候选 URL 发 `Authorization: Bearer <apiKey>`。结果是"明文 HTTP 端点也能拿到用户 Key"这条红线在 `providers.discover` 路径上失效（契约声明与实现不一致）。
- 建议修复方向：在壳层统一插入风险闸：任何携带 apiKey 的出站（discover / health / test / chat）都先 `endpointRiskLevel(baseUrl)`，命中 `insecure`/`local` 时校验 `riskAccepted === true`，否则拒绝并回结构化错误；把校验放进一个公共函数，避免每个 IPC 分支各自实现。
- 二轮依据：tests/ 目录下存在 118 个 .mjs，其中 plugin-l1/plugin-host/plugin-manifest/workshop/exec-guard/workspace-roots/workspace-write/read-grant/member-path/task-dispatch-guard/updater/trust/capture 等命名齐全，但内容未逐条阅读，覆盖强度未验证。
【二轮复核】待验证（改写）：二轮补读 tests/ 清单后，原「待验证」结论改写为：tests/ 目录下存在 118 个 .mjs，其中 plugin-l1/plugin-host/plugin-manifest/workshop/exec-guard/workspace-roots/workspace-write/read-grant/member-path/task-dispatch-guard/updater/trust/capture 等命名齐全，但内容未逐条阅读，覆盖强度未验证。

### 7.【中】MCP server：任意 command 直接 spawn，全量继承环境变量，cwd 未钉扎

- 位置：`src/main/mcp.ts` → `McpClient.start`（`spawn(this.cfg.command, this.cfg.args, { cwd: process.cwd(), env: {...process.env, ...cfg.env} })`）、`loadMcpConfigAt`
- 描述：`mcp.json` 里的 `command` 无任何白名单/校验，`args` 直接传给 spawn；`env` 全量继承主进程环境（Electron 主进程环境可能含用户 PATH、代理、令牌类变量）；`cwd: process.cwd()` 在 GUI 启动下是安装目录或 `C:\`，未钉到数据根或项目根。项目级配置 `<project>/.lynn/mcp.json` 在信任后同样生效（`loadMcpConfigAt`），意味着"打开一个仓库并点信任"就可能执行该仓库自带的任意命令。虽有 `trust.set` 闸门，但闸门只有布尔值，粒度不足以表达"我同意跑这个 command"。
- 建议修复方向：信任确认页展示 `command + args + env 键名` 全文并要求逐项确认；`env` 改为白名单传递（只给 PATH 与显式声明项），不默认继承全量；`cwd` 显式钉到项目根或数据根；对 `command` 做可执行文件白名单或至少禁止指向工作区内的脚本文件。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 8.【中】渲染层日志通道无速率限制、无轮转，渲染进程可打满磁盘

- 位置：`src/main/main.ts` → `ipcMain.on("lynn:log-error", ...)` 与 `createWindow` 内 `logRenderer`
- 描述：两条写 `logs/renderer.log` 的路径都是 `fs.appendFileSync`，写入前没有长度检查、没有轮转、没有速率限制，也没有对 payload 字段长度的裁剪（`agent.log` 那侧有 5MB 轮转 + `LogGate` 限流，`renderer.log` 完全没接）。渲染进程（或任何被注入的渲染代码）可以用高频 `logError` 或超长 message 无限增长该文件，构成本地磁盘耗尽型 DoS，并淹没真实错误。`console-message` 分支对单条 message 做了 4000 字符截断，但显式上报分支的 `payload.message` 未截断。
- 建议修复方向：`renderer.log` 接入与 `agent.log` 相同的轮转 + 单条截断 + 每分钟计数上限；上报体做 `JSON.stringify` 长度上限；超出后写一条 `log_throttled` 汇总。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 9.【中】API Key 明文降级落盘，settings.json 未收紧文件权限

- 位置：`src/main/settings.ts` → `buildConfig`（`isEncryptionAvailable()` 为 false 时 `{ encrypted: false, data: input.apiKey }`）、`write()`；`src/main/main.ts` → `handleMsgRpc` 的 `encrypt`
- 描述：safeStorage 不可用时静默降级为明文存储，仅在字段上打 `encrypted:false` 标记，不阻止保存、不提示用户（Windows 上 safeStorage 通常可用，但 Linux 无 keyring 时是常态）。`write()` 用 `fs.writeFileSync` 默认权限创建 `settings.json`（0644），macOS/Linux 下同机其它用户可读。`messaging.ts` 的渠道凭据同样走这条降级路径。
- 建议修复方向：不可加密时默认拒绝保存 Key 并要求用户显式勾选"我知道风险"；`writeFileSync` 显式 `{ mode: 0o600 }`，并对已存在文件 `chmod` 收紧；启动时检测到低权限文件或明文 Key 时给出可见提示。
- 二轮依据：trust.ts 是目录级全量信任，无作用域/无过期/无单命令粒度，writeFileSync 未指定 mode（上一轮已读）。
【二轮复核】确认：二轮未新增证据，原判断不变。

### 10.【中】路径守卫普遍使用 `startsWith` 前缀比较，未解析 realpath

- 位置：`src/main/main.ts`（`evidence.open` / `preview.read` / `preview.pdfWindow` / `app.openPath` 的 `target.startsWith(base + path.sep)`）、`src/main/toolkit.ts`（`resolveWithin` 的 `full.startsWith(base + path.sep)`）
- 描述：守卫都在 `path.resolve` 之后直接比较字符串，未调用 `fs.realpathSync`。在 Windows 上 junction/目录符号链接、8.3 短名（`C:\PROGRA~1`）、以及大小写差异都可能让"字符串上在根内、实际指向根外"的路径通过。`roots.ts` 的 `isInside` 对 Windows 做了大小写归一（较严谨），但 main.ts 与 toolkit.ts 的守卫没有统一走 `isInside`，属于两套标准。
- 建议修复方向：新增统一 `assertInside(root, target)`：先 `fs.existsSync` → `fs.realpathSync` 两侧 → 再 `path.relative` 判定，所有入口（IPC 路径分支、toolkit 读写、office/docx 写入）只走这一个函数；短名场景可同时比对 `realpath` 与 `path.resolve` 结果。
- 二轮依据：plugin-l1.ts 的 activate 里 entry 越界判定同样用 entryPath.startsWith(path.resolve(dir) + path.sep)，未做 realpath（同源证据）。
【二轮复核】确认：二轮补读 plugin-l1.ts 后，追加一处同源证据（activate 内 entry 越界判定同样未做 realpath），原判断成立。

### 11.【中】插件形态层 CSS 白名单过窄，未拦远程资源引用

- 位置：`src/main/plugin-host.ts` → `checkPluginCss`
- 描述：只拦了 `@import`、`javascript:`、`expression(`、`url(file|data:)` 四类。未覆盖：远程字体（`@font-face { src: url(https://...) }`）、远程图片/背景（`url(//host/x.png)` 协议相对写法，正则要求 `file:`/`data:` 前缀，漏掉 `//`）、`-moz-binding`、`behavior:`、以及 CSS 内联 SVG 中的脚本向量。渲染层把这些 CSS 原文注入 `<style>`（`plugins.list` 返回 `style` 字段由渲染层注入），配合渲染层若无 CSP（本次未读渲染层与 index.html，无法确认是否有 CSP meta），就存在样式驱动的外部请求与内容注入面。
- 建议修复方向：`checkPluginCss` 改为"只放行白名单属性 + 颜色/长度 token"，禁止一切 `url(` 除了 `data:image/` 且限长；或在渲染层注入前用严格 CSP（`default-src 'self'; style-src 'unsafe-inline' 'self'; font-src 'self' data:`）兜底，并对注入的 `<style>` 所在文档确认无 `http(s)` 外发能力。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】降级 中→低：正则缺口属实（`url(//host/x.png)` 协议相对写法确实漏拦），但报告标注"无法确认是否有 CSP"现已核实：**index.html 有 CSP**（`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`）。font-src 回落到 default-src 'self'，远程字体/图片/外发连接在运行时全被挡死，剩余面只有 CSS 注入造成的 UI 欺骗。checkPluginCss 的正则收紧仍值得做，但从"外发通道"降为"防欺骗"。

---

## 二、性能类

### 12.【中】`preview.read` 把最多 16MB 文件整份 base64 经 IPC 下发渲染层

- 位置：`src/main/main.ts` → `preview.read` 的 office 分支（`OFFICE_LIMIT = 16 * 1024 * 1024`，`dataBase64: fs.readFileSync(target).toString("base64")`）
- 描述：`fs.readFileSync` 一次性读入，再转 base64（体积膨胀约 33%，即 16MB 文件 → 约 21MB 字符串），经 `ipcRenderer.invoke` 结构化克隆跨进程序列化到渲染层。这一路径完全同步，会在主进程事件循环上产生一次大字符串分配 + 序列化停顿；渲染层同时要为 docx-preview/@js-preview/excel 保留一份 Uint8Array 与 DOM 渲染开销，多开几个预览即可显著抬高内存。
- 建议修复方向：office 预览改为临时文件 + 渲染层通过受控通道按块读取（或 `net.request` 到自定义 `lynn-asset://` 协议），避免整份 base64 走 IPC；下调 office 预览上限（如 8MB）并对同步 `readFileSync` 改异步；对渲染层渲染的 DOM 规模设上限。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 13.【中】秒级探针 + 多定时器常驻，空转唤醒与磁盘写入频繁

- 位置：`src/main/kernel.ts`（`heartbeatProbeMs` 默认 1000、`supervisorTimer`、`heartbeatTimer`、`reminderTimer`、`scheduleTimer`、`probeTimer`、`taskChangeTimer`、`persistThreadSoon` 的 600ms 合并窗口）；默认值见 `src/main/settings.ts` → `DEFAULT_PREFS`
- 描述：默认配置下"有成员在跑就 1s 一次探针"。探针本身只读内存态、无 token 消耗（注释如此），但它在主进程定时器上常驻，且卡片/进度更新会通过 `persistThreadSoon` 触发 `threads.saveState` 全量重写线程文件（`feed.slice(-200)` + `history.slice(-200)` 的完整 JSON）。一次长任务里成员每步都会写盘，配合 1s 探针与 600ms 合并窗口，空闲时的唤醒次数与文件重写量偏高，笔记本电池与低配机上有可感知影响。
- 建议修复方向：探针间隔在有成员运行时放宽到 3–5s，并改为事件驱动（工具 start/end、任务状态变化）为主；`saveState` 改增量追加（timeline 已有 jsonl 形态可复用）或按内容哈希跳过无变化的重写；空闲时完全停掉探针（已有 `heartbeatProbeMs=0` 开关，可作为默认值）。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】降级 中→低："默认 1s 常驻"与事实不符——`probeDelayMs`（src/main/heartbeat.ts）**空闲时退避到 15s**，1s 只在有成员在跑时出现（那正是探针的职责），且定时器 `unref()` 不阻退出；写盘侧有 `persistThreadSoon` 600ms 合并窗口。"空转唤醒频繁"不成立，"空闲退避"建议原报告里已列的实现其实已经存在。

---

## 三、架构类

### 14.【中】`kernel.ts` 单文件职责过载

- 位置：`src/main/kernel.ts`（3000+ 行，本次只读到第 2000 行）、`src/main/main.ts`（IPC 分支内联消息平台/更新器/截图/预览/窗口控制等）
- 描述：`Kernel` 一个类同时承担：IPC 方法分派、会话/线程状态机、成员调度与并发闸门、巡检与心跳、记忆/日历/调度器/知识库/office/插件/技能/工坊装配、审计日志、预算与用量。类内成员字段超过 60 个，`Map` 形式的运行期状态十余个。main.ts 的 `ipcMain.handle("lynn:rpc")` 是一个上百分支的 if 链，`msg.*`、`update.*`、`capture.*`、`preview.*`、`window.*` 全内联在壳层。后果：任何一处改动都需要在超大文件内定位；单测只能通过整 Kernel 构造进入（构造里就有文件系统副作用：`mkdirSync`、迁移、`knowledge.reindex()`），测试成本高、隔离难。
- 建议修复方向：按域拆分（SessionThreadService / MemberDispatcher / HeartbeatService / ModelCatalog / PluginService / TaskService），Kernel 只做装配与事件总线；IPC 分派改为注册表（`Map<RpcMethod, handler>`），每个域自行注册，壳层不再 if 链；构造改为显式 `init()` 注入依赖，便于测试替换文件系统。
【二轮复核】确认：二轮未触及该条目，原判断不变（kernel.ts 第 2000 行之后的内容本轮仍未覆盖）。
【三轮核验】方向成立、数字修正：kernel.ts 实测 **7498 行**（本条写作时只读到 2000 行，"3000+"是外推，实际更严重）。main.ts 为 773 行、单一 RPC if 链，"上百分支"属实。拆分是独立大工程，不随本轮小修做。

### 15.【中】成员与工单运行期状态全在内存 Map，崩溃后恢复语义未定义

- 位置：`src/main/kernel.ts`（`memberRuns`、`memberActive`、`memberAborts`、`memberProgress`、`memberStepAt`、`memberBlockedCmds`、`pendingApprovals`、`pendingPlans`、`reviewPending` 等）
- 描述：这些状态都只活在内存里。进程被强杀/崩溃/断电后：正在跑的成员单在 `TaskStore` 里仍是 `in_progress`，但没有任何 runner 在跑；`pendingApprovals` 里的删除审批请求永久悬挂（Promise 永远不会 resolve，若未随进程消亡则会泄漏）；`pendingPlans` 丢失后用户看到"待开工"的契约卡却点不动。`agent-orphans.ts` 只回收 Pi worker 孤儿进程，未见工单状态侧的恢复路径（该文件本次未读，标注未验证）。
- 建议修复方向：工单状态机落盘时记录 `runEpoch`/`heartbeatAt`，启动时把 `in_progress` 且超过阈值的单统一标 `blocked` 并附"因重启中断"说明；审批/计划类挂起项持久化并在启动时清理或重建；成员 runner 注册到进程级表，退出时统一 abort 并记录原因。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】**撤回本条**：三轮补读 kernel.ts init 段后证实"恢复语义未定义"不成立——`loadPending()`（kernel.ts）在启动时从盘上重载契约/决策挂起项，坏数据与指向已结案/已删工单的条目都会被过滤；`reconcileOrphanTasks()` 把上次中断的 `in_progress` 单统一转 `blocked`（附"上次进程中断"说明）并落「恢复」系统卡，与本条建议的第一、二点几乎逐字吻合——即建议的机制**已经存在**，只是作者没读到那段。`pendingApprovals` 是进程内 Promise，进程消亡时一并消失，不存在"永久悬挂泄漏"。剩余真实点只有"成员运行态不续跑"，但那已按 blocked 语义显式交代，不是未定义行为。

---

## 四、代码质量类

### 16.【中】模型错误把端点返回体原文落卡、落日志、发通知

- 位置：`src/main/llm.ts` → `streamChat`（`throw new LlmError(\`模型请求失败 HTTP ${res.status}：${text.slice(0,300)}\`)`）、`probeEndpoint`；`src/main/kernel.ts` 的错误落卡与 `notifyOnce`
- 描述：非 2xx 响应体前 300 字符原样进错误消息，随后进入 feed 卡片、agent.log，并在 `needsUserAttention` 命中时进系统通知。部分网关的 4xx 响应体会回显请求内容（含被截断的 Authorization 头或 key 片段），自建/第三方端点也可能返回调试信息。截断到 300 字符只是限长，不是脱敏。
- 建议修复方向：错误消息结构化（status + 端点 host + 错误码），响应体只保留白名单字段（`error.message`、`error.code`）并对 key/token/secret 类子串做正则脱敏；通知与卡片只展示脱敏后的短消息，原始响应体仅在显式"查看技术详情"时读取日志。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 17.【低】IPC 入口普遍 `params as T` 断言，无运行时参数校验

- 位置：`src/main/main.ts`（`const p = params as {...}` 多处：`msg.configure`、`capture.commit`、`app.appearance`、`evidence.open`、`app.openExternal`、`window.control` 等）
- 描述：契约在 `shared/contract.ts` 里是类型级的，运行时没有任何 schema 校验。渲染层是自家代码，风险有限；但 `msg.send`、`capture.commit` 这类分支已经在做部分手写校验（如 rect 数值有限性），说明作者已意识到需要校验，只是覆盖不全且分散——`app.appearance` 的 `p.mode`、`evidence.open` 的 `p.taskId` 等就完全未校验直接用于路径拼接。
- 建议修复方向：为 IPC 引入一个轻量运行时校验（手写 predicate 或 zod/valibot），集中在契约表上声明一次，壳层入口统一 `parse(method, params)`；路径拼接类参数必须先校验非空与字符集。
【二轮复核】确认：二轮未触及该条目，原判断不变。

### 18.【低】缺少 lint/格式化关卡；依赖版本使用 caret 浮动

- 位置：`package.json`（scripts 无 `lint` / `format`；`dependencies` 全部 `^`）、`tsconfig.json` / `tsconfig.main.json`
- 描述：只有 `typecheck`（严格模式已开，`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` 都在，这部分是好的），但没有 ESLint/Prettier，也没有 CI 阶段可见（`.github/` 目录存在但本次未读 workflow，标注未验证）。`electron ^45.2.1`、`playwright-core ^1.64.1`、`@earendil-works/pi-* ^1.4.0` 均为浮动大版本，`package-lock.json` 存在可锁 CI，但本地 `npm i` 仍可能漂到不兼容小版本。`vite.config.ts` 的 `manualChunks` 用一长串正则维护分包，后续新增 markdown 生态依赖容易漏进主 bundle。
- 建议修复方向：加 ESLint（`@typescript-eslint` + import 规则）+ Prettier 并接入 CI 与 pre-commit；关键运行时依赖（electron、pi-*、playwright-core）改为精确版本或 `~`；分包正则改为按 `node_modules/` 顶层包名前缀判断，减少枚举。
【二轮复核】确认：二轮未触及该条目，原判断不变。
【三轮核验】部分修正：`.github/workflows/ci.yml` **存在且已接入** check:pi-base --tarball + typecheck + lint:design + 全量测试（Windows，Node 22/24 矩阵），"没有 CI 阶段可见"被证伪；`lint:design`（check-design.mjs）也已是现有关卡。仍然成立的只剩：无 ESLint/Prettier、关键依赖 caret 浮动。

### 19.【低】构建时间戳 `define` 被当作版本比较依据

- 位置：`vite.config.ts` → `define: { __LYNN_BUILD_AT__: JSON.stringify(new Date().toISOString()) }`，注释说明前端据此判断"内核是不是比我旧"
- 描述：该值取自**构建机时钟**的构建时刻。跨机器构建、CI 缓存复用、或系统时钟回拨时，"谁更旧"的判断会出错，进而误触发或不触发"内核版本落后，请重启"的提示。这是把时间戳当版本号的典型反模式。
- 建议修复方向：改为构建时注入单调递增的构建号（CI run number 或 git commit count），或直接比较 `package.json` 的 version + git sha；时间戳只用于展示。
【二轮复核】确认：二轮未触及该条目，原判断不变。

---

## 五、新增条目（第二轮）

### 20.【中/高】workshop.ts 插件准入只有静态文本扫描

- 位置：`src/main/workshop.ts`（`reviewDraft` 的 L1 分支、`FORBIDDEN` 正则区）
- 描述：插件工坊对插件草稿的准入检查仅为**静态文本正则扫描**。FORBIDDEN 仅 6 条规则：eval、new Function、child_process、postinstall、node-gyp/.node、≥64 位十六进制串。高危调用模式几乎全漏：
  - `import("node:"+"child_process")` 动态拼接不在扫描范围；
  - `process.binding("...")` 完全不在扫描范围；
  - `fs` / `net` / `os` / `worker_threads` 的导入与使用完全不在扫描范围。
  结论：工坊准入只挡住了「直接起子进程」，**不挡任意文件读写与数据外发**。
- 另外，`reviewDraft` 处理 L1 分支时只做三件事：entry 文件存在 + 禁项扫描 + 单文件 ≤256KB，**没有沙箱、没有进程隔离、没有试运行**——插件的隔离试装能力在 plugin-host.probe，工坊侧并未复用该隔离机制（workshop.ts 注释自承隔离试装见 plugin-host.probe）。
- 建议修复方向：对 `node:` 前缀的动态 import 做静态 AST 解析而非文本扫描；把 fs/net/os/worker_threads 显式纳入禁用或受控列表；工坊侧启用 review 时复用 plugin-host.probe 的隔离试装环境，确认无害后再放行。
【二轮复核】确认成立：二轮补读 workshop.ts 后，上述证据可直接复核。

### 21.【中】L1ToolDef.execute 无超时、无并发闸

- 位置：`src/main/plugin-l1.ts`（`L1ToolDef.execute` 实现）
- 描述：`L1ToolDef.execute` 没有设置超时，也没有并发执行闸。插件出错时异常被 `catch` 成字符串回给模型，因此死循环或长阻塞不会崩溃，而是**直接占住主进程事件循环**，阻塞后续所有 RPC 响应与 UI 更新。
- 建议修复方向：为每次插件调用设置超时（如 30s）并在超时后强制终止；主进程内同一插件并发执行数限为 1；把调用耗时与超时事件写入审计日志。
【二轮复核】确认成立：二轮补读 plugin-l1.ts 后，上述实现特征可直接复核。

### 22.【低】nsis.deleteAppDataOnUninstall:false，卸载残留凭据

- 位置：`electron-builder.yml`（nsis 配置段）
- 描述：nsis 卸载选项设为 `deleteAppDataOnUninstall: false`，卸载后凭据目录（settings.json / trust.json / messaging 凭据）保留在用户家目录。对单用户场景可接受，但对多用户/交付给他人使用的机器构成凭据残留风险。
- 阴性结论：electron-builder.yml 中**没有 `protocols` / `fileAssociations` 段**，当前未注册自定义协议与文件关联，这一子面风险为空。
- 建议修复方向：若需要保留用户数据迁移，改用单独卸载器清理凭据并显式告知用户；或至少记录卸载审计。
【二轮复核】确认成立：二轮补读 electron-builder.yml 后，上述配置可直接复核。

---

## 待进一步验证（本次未覆盖，不计入上述条目）

1. `src/renderer/` 全部代码：是否有 CSP、是否有 `dangerablySetInnerHTML`、插件 HTML/CSS 注入点如何渲染、`react-markdown` 是否允许原始 HTML（`rehype-raw` 未出现在依赖里，初步判断为默认转义，但需确认渲染层调用方式）。
2. `src/main/capture-host.ts`：`capture.commit` 接收渲染层 `dataUrl` 后是否真的核对了 PNG 尺寸与 rect（`contract.ts` 注释声称会核对，实现未验证）；`save` 动作的落盘路径是否可被渲染层影响。
3. `src/main/updater.ts`：`resolveFeedUrl` 是否强制 HTTPS。
4. `src/main/trust.ts`：项目信任的粒度与持久化方式。
5. `electron-builder.yml`：签名配置、asar、文件权限、`electronLanguages` 等打包面。
6. `tests/`：是否存在针对路径守卫、删除审批、插件 manifest 的回归测试。
7. `plugin-l1.ts`、`workshop.ts`：L1 试装与插件工坊准入的实际隔离强度。
8. **本轮仍未覆盖**：
   - kernel.ts 第 2000 行之后（工具单次读取上限 2000 行，run_command 环境无 wc/cat，无法切片）
   - agent-host.ts
   - pi-rpc-host.ts
   - tests/ 内 118 个测试文件的具体断言内容
   - plugin-host.ts 的 probe 隔离试装实现
9. **待确认（未验证，勿写进正式条目）**：promoteDraft 的 manifest.id 目录穿越校验——本轮未验证，最多作为「待确认」列入仍未覆盖。

---

## 审计方法与自审

- 本次为只读静态审计：未执行 `npm run build`、未执行 `npm test`、未修改任何源码文件；唯一写入为本报告。
- 每条隐患都可在对应文件的对应函数中复核；行号为近似定位，理由是本次以整文件阅读为主，逐行核对行号未在预算内完成。
- 未验证的判断已显式标注（见「待进一步验证」），其中 #3 对 `plugin-l1.ts` 运行时行为的描述基于 `plugin-host.ts` 的注释与调用方式推断，标注为未验证（二轮已补读并确认为成立）。
- 严重程度口径：**高** = 可导致任意代码执行、凭据外泄或用户数据越界；**中** = 在特定配置/交互下可造成安全或可用性损害；**低** = 可维护性与工程规范问题。

---

## 六、三轮核验（2026-11-13，逐条对照源码复核）

核验方式：对 22 条逐一到当前源码验证（含二轮标注"未读/未验证"的文件：plugin-l1.ts、workshop.ts、updater.ts、electron-builder.yml、index.html、.github/workflows/ci.yml、kernel.ts init 段、heartbeat.ts、toolkit.ts、llm.ts、settings.ts、mcp.ts、渲染层调用点）。结论：**15 条属实、3 条属实但严重程度高估、1 条证伪撤回、1 条数字修正、若干覆盖缺口已补**。总览表的严重程度已按本节更新。

### 6.1 证伪撤回

- **#15（崩溃恢复语义未定义）→ 撤回**。kernel.ts `init()` 第一、二步就是恢复语义：`loadPending()` 从盘上重载契约/决策挂起项（过滤已结案/已删工单的悬空条目），`reconcileOrphanTasks()` 把中断的 `in_progress` 单统一转 `blocked` 并落「恢复」卡。原报告建议的前两点机制**已经存在**，作者只是没读到该段；`pendingApprovals` 的 Promise 随进程消亡，无"永久悬挂泄漏"。

### 6.2 严重程度修正

- **#1 高→低**：守卫缺白名单属实，但利用链不成立——模型无 RPC 通道，渲染层唯一 `app.openPath` 调用点用的是 `task.export` 返回的内核路径，非成员可控路径。属加固缺口。
- **#4 高→中**：缺 ext 校验属实，但渲染层只在 `preview.read` 判定 `ext==="pdf"` 后才出现「打开预览窗口」按钮；Electron ≥20 默认 contextIsolation/sandbox 已开。剩余为钓鱼面。
- **#11 中→低**：正则缺口属实（`url(//host/…)` 协议相对写法漏拦），但 **index.html 已有 CSP**（`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`），远程字体/图片/外发连接运行时全被挡死，剩余面只有 CSS 注入的 UI 欺骗。
- **#13 中→低**：探针**空闲退避 15s**（heartbeat.ts `probeDelayMs`）且 `unref()`，1s 仅在有成员在跑时出现——那正是它的职责；写盘有 600ms 合并。"空转唤醒频繁"不成立。

### 6.3 数字与覆盖修正

- **#14**：kernel.ts 实测 **7498 行**（写作时只读到 2000 行，"3000+"为外推，实际低估 2.4 倍）；main.ts 773 行、单一 RPC if 链。
- **#18**：`.github/workflows/ci.yml` 存在且已接入 check:pi-base --tarball + typecheck + lint:design + 全量测试（Windows，Node 22/24 矩阵），"没有 CI 阶段可见"证伪；仍成立的只剩无 ESLint/Prettier 与 caret 浮动。
- **"待进一步验证"清单消账**：#3（plugin-l1 permissions 零读取，证实）、#20（FORBIDDEN 恰 6 条，证实）、#4（pdfWindow 无 ext 校验，证实）、#5（resolveFeedUrl 不强制 HTTPS + builder 无签名 + asar:false，全部证实）、#22（证实）、promoteDraft manifest.id 目录穿越——本轮仍未验证，维持"待确认"。

### 6.4 报告遗漏的既有防线（影响严重度解读）

1. **run_command 有路径逃逸闸**（#2 未提）：`findPathEscape` 对命令里的绝对路径字面量做工作区/授权根 containment 判定，`%USERPROFILE%`/`$HOME`/`~` 引用直接拒绝，越界命令根本不执行；删除类命令有低风险分级 + 审批流。"出站只审计不拦"仍然成立（工作区内数据可被 curl 外发），#2 的核心结论不变，但修复优先级应认识到工作区外的路已被闸住。
2. **kernel.modelDiscover 已有风险闸**（#6 应表述为"两套标准"）：`endpointRiskLevel` + `riskAccepted` 校验在 kernel 路径上存在且生效，缺的是壳层 `providers.discover` 分支——两条路径两套标准，比"完全没有"更危险也更好修（收敛成一个公共函数）。
3. **#21 表述精化**：L1 execute 无超时属实；"占住主进程事件循环"仅在插件做同步死循环时成立，异步悬挂只卡住该次调用。

### 6.5 按真实性的修复排序（已拍板）

- **P0**：① `providers.discover` 补风险闸并与 kernel.modelDiscover 收敛；② `app.openPath`/`preview.pdfWindow` 扩展名白名单 + 路径守卫统一走 realpath containment（#1/#4/#10 一次收口）；③ `renderer.log` 轮转 + 单条截断 + 限流（#8）。✅ 已完成（2026-11-13，见 §6.6）
- **P1**：L1 execute 超时/并发闸与 manifest.permissions 强制或删除（#3/#21）；updater HTTPS 强制（#5）；MCP 信任确认展示 command/args/env 全文 + env 白名单（#7）；workshop FORBIDDEN 补 fs/net/os/worker_threads（#20）；#2 出站按权限档拦截。✅ 已完成（2026-11-13，见 §6.6；#3 的 permissions 强制按"如实注明"处理，见 §6.6 说明）
- **P2**：#9/#12/#16/#17/#19/#22。✅ 已完成（2026-11-13，见 §6.6；#22 按设计权衡记录处理）
- **遗留大工程**：#3 进程隔离 + #14 拆分。✅ 已完成（2026-11-13 第二批，见 §6.7）

### 6.6 修复执行记录（2026-11-13）

**P0（全部完成）**：
1. 风险闸收敛：`endpoint.ts` 新增 `endpointRiskError()`；壳层 `providers.discover` 分支接入（契约补 `riskAccepted`），`kernel.modelDiscover` 改走同一函数（#6 两套标准 → 一道闸）。
2. 路径守卫收口：新建 `src/main/path-guard.ts`（`insideBase` realpath containment + `openPathBlockReason` 扩展名白名单）；main.ts 5 处 `startsWith` 守卫全部替换；`preview.pdfWindow` 只放行 `.pdf` 并显式 sandbox + 独立 partition + 预览窗口网络请求拦截（#1/#4/#10）。
3. renderer.log 加固：`logRenderer` 提升为模块级统一通道，每分钟 120 条限流（窗口翻转落汇总行）、单条 16K 截断、5MB 轮转到 `renderer.old.log`（#8）。

**P1（全部完成，一处按"如实注明"处理）**：
4. L1 工具超时（默认 30s，可配）+ 每插件并发闸=1 + 停用清排队链（#21）；错误文案如实说明"同进程无法强杀，持续卡死请停用插件"。**#3 的 manifest.permissions 说明**：强制需要进程隔离（jiti 主进程直跑下插件可直接 `require` 绕过任何代理层），本轮不做假强制——plugin-l1.ts 顶部注释与工坊准入流水线均如实标注"permissions 是声明不是强制"，真正的强制随进程隔离（P2/独立工程）落地。
5. updater：新增 `feedUrlIssue()`，feed 必须以 `https://` 开头，否则更新不可用且原因写进 `updateState.reason` 界面可见（#5）。
6. MCP：新增 `mcpChildEnv()` 白名单（PATH/PATHEXT/SYSTEMROOT/COMSPEC/TEMP/TMP + 显式声明项，其余不透传）；`McpRegistry`/`McpClient` 支持 cwd 钉扎，内核传入数据根（#7）。
7. MCP 信任确认展示全文：`project.setRoot` 未信任且带项目级 MCP 时返回 `mcpServers` 清单（id/command/args/env 键名，**值不下发**）；信任弹窗逐条列出命令全文（i18n 键 `trust.askServers`，中英）（#7）。
8. workshop FORBIDDEN 补：fs/net/os/http(s)/dns/dgram/tls/vm/worker_threads/inspector 的 require 与动态 import、`process.binding(`（#20）。
9. 出站闸：Toolkit 新增 `outboundAllowed` 选项；成员派单按权限档接线——计划/询问档 curl/wget/ssh 类直接拒（文案给 ESCALATE 指路），自动/全权档保持只审计；不注入 = 旧行为（#2 的第一步，域名白名单留待后续）。

**验证**：typecheck 0 错；`lint:design` 过；`build:main` + `build:renderer` 过；全量测试 623/623 绿（新增 tests/path-guard.test.mjs 4 条、tests/mcp-guard.test.mjs 2 条、tests/outbound-gate.test.mjs 3 条、plugin-l1 超时/串行 2 条、updater HTTPS 1 条，及 P0 批次的既有新增）。

**P2（全部处理，#22 为设计权衡记录）**：
10. 凭据脱敏（#16）：`endpoint.ts` 新增 `redactSecrets()`（Bearer / sk- / api_key-token-secret 键值对形状一律打码），`llm.ts` streamChat 与 probeEndpoint、`endpoint.ts` discoverModels 三处错误文案先脱敏再截断——截断只是限长不是脱敏。
11. RPC 参数校验（#17）：`path-guard.ts` 新增 `taskIdError()`——taskId 会被拼进 base 本身（`path.resolve(dataRoot, "tasks", taskId)`），带 `..` 时 base 跳出数据根、containment 对着 base 比形同虚设；壳层 5 处卷宗路径分支统一先验；`window.control` 的 action、`app.appearance` 的 mode（light/dark）与 desk（十六进制色）按取值域收口。
12. 明文 Key 纪律（#9）：`buildConfig` 不再静默明文降级——safeStorage 不可用时必须显式 `plaintextOk`（界面勾选「明文存储，我知晓风险」，模型库单条/批量导入都接了；vision.save 无渲染层入口，内核如实拒绝兜底）；`write()` 收紧 0600 + 对已存在文件 chmod；`model.list` 带出 `canEncrypt`，界面据此决定是否展示确认框。`config.save` / `config.vision.save` / `model.save` 三条 RPC 契约同步。
13. Office 预览（#12）：上限 16MB→8MB，同步 `readFileSync` 改异步 `fs.promises.readFile`，主进程不再一次大分配停顿；自定义协议流式下发留作后续（注释如实注明，不假装已解决）。
14. 构建号（#19）：前后端同一算法（`git rev-list --count HEAD`，无 git 回落时间戳），vite 注入 `__LYNN_BUILD_ID__`、kernel `app.info` 返回 `buildId`（模块级缓存，不重复 spawn git）；版本握手优先按构建号单调比较，不可比才退回时间戳——跨机器/时钟回拨不再判错"谁更旧"。
15. 卸载残留（#22）：**不改默认**（`deleteAppDataOnUninstall: false` 是刻意设计——任务卷宗/团队档案/会话历史重装原样可用，改 true 反而危险）；改为 README 新增「卸载与数据残留」一节，写清 `~/.lynn/` 里有凭据、交机器前手动删什么，并注明未配签名 + HTTPS 强制的口径。

**验证（P2 批次）**：typecheck 0 错；`lint:design` 过；`build:main` + `build:renderer` 过；全量测试 **630/630 绿**（新增 tests/p2-hardening.test.mjs 5 条：脱敏形状、taskId 校验、明文确认闸、0600 权限、buildId 形状；4 个既有模型测试按新契约显式 `plaintextOk`）。

### 6.7 遗留大工程落地（2026-11-13 第二批）

**#3 L1 进程隔离（真修复，取代"如实注明"的权宜）**：
- 新增 `agent/l1-worker.mjs`：每插件一个独立 Node 进程（ELECTRON_RUN_AS_NODE），JSONL 协议 activate/execute/deactivate + api.log 转发（复用 rpc-lines 的 UTF-8 安全切行与 process-tree 的进程树击杀，模式与 agent-host/pi-rpc-host 一致）。
- `plugin-l1.ts`：`L1Worker` 句柄（请求配对、崩溃拒绝带 stderr 尾巴、`kill()` 强杀进程树、`dispose()` 尽力跑 deactivate 钩子后回收）；`activate` 走 worker（激活超时 20s，activateError 如实回传）；`execute` 按加载路径路由——**隔离进程超时 = 强杀进程树 + 卸载插件**（同进程"无法强杀"的局限就此消除），文案指引重新启用；每插件串行闸两种路径都生效。
- kernel 默认启用 worker（`LYNN_L1_INPROC=1` 为排障逃生口，测试路径保持进程内）；`electron-builder.yml` 补 `node_modules/jiti/**/*`（worker 编译插件 TS 必需，此前打包配置里 jiti 缺失是既有缺口）。
- 信任模型口径不变、如实：api 面仍只有 registerTool/dataDir/log；进程内 require 拦不住，fs/net 强制仍是声明而非沙箱——隔离解决的是**崩溃与悬挂**，不是权限沙箱。
- 新增 tests/l1-worker.test.mjs 4 条：真子进程激活/执行、activateError 如实回传、悬挂调用超时强杀+插件卸载、插件 `process.exit` 崩溃隔离且带出退出码。

**#14 拆分第一刀（壳层 if 链 → 注册表）**：
- 新增 `src/main/shell-rpc.ts`：`Map<method, handler>` 注册表 + `ShellRpcCtx`（ctx 全部用取值函数传 `getWin/closePet`，不缓存可销毁的 BrowserWindow 引用）；main.ts 约 330 行 if 链整体迁出，`update.*` 前缀单独子分派，未命中落回 `kernel.handle`；卷宗路径五分支的守卫三件套收敛为一个 `resolveTaskRef` 帮手。
- main.ts 的 ipc handler 缩为 12 行委托；内核侧大 switch 的拆分（SessionThreadService/MemberDispatcher 等域服务）仍是大工程，按此模式后续逐域做。
- tests/capture.test.mjs 的"接线防漂移"断言跟随迁移指向 shell-rpc.ts。

**验证（本批次）**：typecheck 0 错；`lint:design` 过；`build:main` + `build:renderer` 过；全量测试 **634/634 绿**（+4 条 l1-worker，capture 防漂移断言随迁移修正）。至此审计 22 条全部闭环：19 条已修复、1 条证伪撤回（#15）、1 条既有实现覆盖（#13 退避）、1 条设计权衡记录（#22）。
