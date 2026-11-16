# 阶段性审查：18cb65a / 329aded / f4eb6a1 / 7e4f7e6

**日期**：2026-11-16
**范围**：远程本轮 5 个提交（2026-11-15 夜间推送）
**结论**：功能整体可用，但有一个 P0 功能缺陷（Office 预览整条链路跑不通）与一个形式化重构（kernel 拆域只搬了 6 个透传方法）；共修 5 类问题、迁移 39 个 RPC 到注册表，并补上读后写保护。

---

## 一、P0：lynn-asset:// 自定义协议在渲染层被 CORS 拦死

`f4eb6a1` 把 Office 预览改成"主进程签发一次性令牌 → 渲染层 `fetch("lynn-asset://...")`"。
用真实 Electron 窗口按实际方式（页面从 `file://` 加载）实测：

```
Access to fetch at 'lynn-asset://preview/<token>' from origin 'file://' has been blocked
by CORS policy: Cross origin requests are only supported for protocol schemes:
chrome, chrome-extension, chrome-untrusted, data, http, https.
```

- Chromium 对 fetch 的目标协议有硬限制，自定义 scheme 即使 `registerSchemesAsPrivileged({supportFetchAPI: true})` 也拦。
- 加 `standard: true`、改 CSP、加响应头都无效（已逐个试过）。
- 后果：打开 docx/xlsx/pptx 只会看到「预览失败（Failed to fetch）」。
- 该提交的 5 条单测只覆盖令牌签发/核销/扩展名，覆盖不到 fetch 与协议注册这条链路。

**修法**：`preview.read` 直接返回 `dataBytes: Uint8Array`（IPC 结构化克隆），删掉 `asset-protocol.ts`、协议注册与 CSP 的 `connect-src`。仍不经过 base64（没有 33% 膨胀）。
**验证**：单独冒烟确认 `ipcMain.handle` 返回的 TypedArray 在渲染层仍是 `[object Uint8Array]`、字节数与首字节一致。

## 二、P1：路径守卫只做了一半

`18cb65a` 把文件读写的 containment 换成 `insideBase`（双侧 realpath），但：

| 入口 | 原状 | 处置 |
|---|---|---|
| `run_command` 的 `cwd` | 纯词法判定，工作区里指向根外的 junction 就能把命令带出去 | 补 realpath 复核 |
| `assertWritable` 的 `.git/.lynn` | 按词法首段判，`ws/git-link -> .git` 可绕过 | 改用真实路径判定 |

另外 Office 预览曾把授权根一刀切成 `dataRoot/tasks`，会让"项目工作区里的已登记交付物"从能预览退化成"请用系统程序打开"——该分支在 P0 改造后不再有第二道 allow list，问题消失。

## 三、阶段三重构：形式达标、实质空转

`7e4f7e6` 的交付是"新建注册表 + 把 6 个 model.* 从 switch 挪到 rpc-registry.ts"。审查时的问题与处置：

| 问题 | 处置 |
|---|---|
| `RpcHandler` 的泛型只影响返回值，params 被抹成 `Record<string, unknown>` | 入参/返回值都改由 `RpcContracts[M]` 推导 |
| handler 内 `as` + `handle()` 内再 `as`（第二层让第一层失效） | 删除第一层，类型收口唯一留在 `Kernel.xxxRpcDeps()` |
| 把整块 `settingsRpc` 改 public（绕过 handle 的旁路） | 改为注入窄接口，撤掉 public getter |
| 测试改动里新增的 `registry.register` 匹配是死代码（kernel.ts 里 0 次出现） | 删除；改为运行时断言注册表 `has/methods/handle` |
| kernel.ts 缩进被改成 7 空格、留"墓碑注释" | 清理 |

**后续三批**：把纯域方法真正搬出 switch，kernel.ts 9268 → 9154 行：

- 第二批 `thread.*` 九件（`thread.halt` 留在 kernel：停成员、断回合、清待验收属跨域编排）
- 第三批 `calendar.*` 七件 / `schedule.*` 五件 / `kb.*` 四件 → `rpc/calendar-rpc.ts`、`rpc/schedule-rpc.ts`、`rpc/kb-rpc.ts`
- 第五批（本次）`data.usage` / `data.cleanup` / `config.clearKey` / `config.vision.*` / `ui.plugins` / `humanizer.status` 八件
- 注册表累计 39 个方法，`RpcDeps` 按域注入，任一域都不持有 Kernel 实例
- `config.save` / `config.test` **有意留在 kernel**：它们要过端点风险闸、复用已存 Key 解密，搬进域只会多一层注入而不减风险，记在这里免得后人以为漏了

## 四、其它已修

- `redactSecrets` 原先在 `endpoint.ts` 与 `memory.ts` 各写一份、覆盖的令牌形态不同（前者 Bearer/`xx key=`，后者 ghp_/xox/AKIA）。已合并到 `src/shared/redact.ts`，并修掉 `max_tokens`/`total_tokens` 这类计数键被误打码的问题。
- 全局错误条复用 `.stale-bar` 的铜色图标（读作"提示"），改为 `err-bar` 用红线色；关闭按钮的 `aria-label` 走 i18n。
- OfficePane 每次挂载都整块复制一份字节（8MB 级），改为整块复用、仅 subarray 才切。
- 右下角两条提示（版本握手 / 全局错误）改为 `.toast-stack` 列容器堆叠：原先靠各自写死 `bottom: 64 / 16` 错开，错误文案一换行就压到上一条。
- **读后写保护**（`Toolkit.assertFresh`）：`read_file` 记下 mtime/size，`write_file` / `edit_file` / patch 写前比对——读过之后文件被外部改过就拒绝盲写并提示重读；没读过的文件维持"整份覆盖"原行为，不打断正常创作。局限：保留 mtime 且同字节数的改写能绕过（不做全文哈希，那等于每次写多读一遍）。
- 打包配置排除 `dist/_tmp/**`：本机验证脚本会把 preload 探针与截图写在那里，不该跟着安装包发出去。

## 五、交接文档的不实之处（以代码为准）

| 交接文档写的 | 实际 |
|---|---|
| 阶段三"未提交 / `?? rpc-registry.ts`" | 已推送为 `7e4f7e6` |
| 仓库 `https://atomgit.com/Messao/lynn` | 实际 origin 是 `https://gitcode.com/Messao/lynn` |
| 约束"只改 src/main/，不修改 tests/" | 同文档 6.1 又要求改测试正则；实施方改了测试让测试变绿 |
| 提交信息"全量 796/808（余 5 个 Windows 平台限定项）" | 796 + 5 ≠ 808，差的 7 个无解释 |

## 六、验证基线（本次）

- `typecheck` 0（main + renderer）、`oxlint` 0、`lint:design` 通过
- `build:main` + `build:renderer` 通过
- 全量测试绿（含新增 `tests/redact.test.mjs` 4 条、`tests/toolkit-cas.test.mjs` 6 条、`tests/rpc-registry.test.mjs` 覆盖 39 方法、`p1-shell-evidence-pet` 的 Office 通道防漂移断言）

## 七、8MB 字节过 IPC 的实测数据（2026-11-16）

真实 Electron 窗口（`contextIsolation: true`，与生产一致），`ipcMain.handle` 返回 `Uint8Array`，
经 `ipcRenderer.invoke` → `contextBridge` 回到页面：

| 轮次 | 总耗时 | 单次 | 渲染进程 workingSet |
|---|---|---|---|
| 1 次 | 17 ms | 17 ms | 73 → 87 MB（+14） |
| 5 次 | 93 ms | 18.6 ms | 73 → 115 MB（+42） |
| 20 次 | 454 ms | 22.7 ms | 72 → 159 MB（+87，含未回收） |

同一轮验证了 contextBridge 不会拍平 TypedArray：`Object.prototype.toString` 仍是 `[object Uint8Array]`，
长度 8388608，首尾字节与源数据一致（80 / 75）。结论：8MB 上限下 Office 预览的字节通道可用，
单次 17–23 ms；连续多次会累积未回收内存，正常使用（一次预览一份）不构成问题。

## 八、仍开放

1. CAS 有局限（保留 mtime + 同字节数改写绕得过）；要更强就得落全文哈希或 mtime 之外的文件 id。
2. kernel.ts 仍有 63 个 case 在 switch 里：task(14) / team(9) / config(6) / session(6) / project(5) /
   plugins(5) / workshop(5) / memory(5) / workspace(5) 等。这些域的依赖重、编排跨域，
   适合按域一批一批搬，不适合为了行数硬拆。
3. 安装包体积（`npm run dist`）本次未重新实测，`-27.6%` 仍是上一轮的估算口径。
