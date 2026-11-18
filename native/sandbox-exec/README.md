# sandbox-exec · 成员进程沙箱

> 13 章 §2 的 **L1 保底**（Job Object）与 **L2 探针**（AppContainer 可用性判定）。
> 零依赖 Rust：不引 `windows` crate，全部裸 FFI —— `cargo build --offline` 就能编，不必联网。

## 命令

```bash
npm run build:native     # 构建 + 拷到 dist/ + 跑一次探针
npm run probe:sandbox    # 打印当前机器的判定（哪一档、为什么）
```

```bash
sandbox-exec --probe                  # 一行 JSON：能不能隔离、为什么
sandbox-exec --derive <profileName>   # 只取 SID（诊断用）
sandbox-exec --delete [profileName]   # 删 profile（卸载/回退）
sandbox-exec --run  [--memory-mb N] [--processes N] -- <exe> [args...]
sandbox-exec --shell [--memory-mb N] [--processes N] -- <命令原文>   # 交给 cmd /d /s /c
```

## 已验证（本机 Win10 19042，2026-11-17）

| 能力 | 结果 |
|---|---|
| 输出透传（stdout/stderr） | ✅ 子进程输出回得来 |
| 退出码透传 | ✅ `process.exit(9)` → 9 |
| 内存上限 | ✅ 限制 128MB 时分配 1GB 失败；同样代码在 2GB 限制下成功 |
| 进程数上限 | ✅ `--processes 4` 时只能起 2 个子进程；不限制时 8 个全成 |
| 中文与管道 | ✅ `echo 中文 && echo ok` 正常 |
| 父进程退出杀子进程 | ✅ `KILL_ON_JOB_CLOSE` |

## 没做到的（必须知道）

**AppContainer 的启动路径没有实现，也没有验证。** 探针只做到「profile 能建、SID 能派生」：

```json
{"provisioned":true,"launchVerified":false,"mode":"jobonly"}
```

本机是**内置管理员账户**（SID 尾号 500），令牌里没有 `S-1-15-2-1`（ALL APPLICATION PACKAGES）。
Windows 的内置管理员**本来就不能使用 AppContainer/打包应用**。所以：

- `mode` 恒为 `jobonly`，`limits.noNetwork` 与 `limits.fileIsolation` 恒为 `false`；
- 也就是说：**断网和文件 ACL 隔离这两项在当前机器上并未生效**。jobonly 挡的是进程风暴与内存打爆。
- 要真正拿到断网/隔离，得在一个**普通用户账户**下跑，并补上 `CreateProcessAsUser` +
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 的启动实现与十条绕过用例验证。

**为什么不把没验证的启动代码也写上**：一段从没跑通过的沙箱代码比没有更危险——
它会让界面显示"已隔离"，而实际全通。缺就明确说缺。

## 几个踩过的坑（写下来省下一个人两小时）

1. **`CreateAppContainerProfile` 的 `ERROR_ALREADY_EXISTS`（0x800700B7）不是失败**。
   把它当失败会让探针时真时假：同一台机器第一次报「不支持」，隔一会儿又报「已存在」。
2. **不能把整条命令行套一对引号**。`CreateProcessW` 会把带引号的整串当程序名 → `err=2`。
   逐参数按 Windows 规则加引号，argv0 交系统按 PATH 解析。
3. **不要自己给 shell 命令加引号**。`node -e "process.exit(9)"` 被拼成
   `cmd /c "node -e "process.exit(9)""` 后，cmd 的引号剥离会把它拆坏——实测**退出码恒为 0、
   命令根本没执行**（静默失效，最坏的一种）。用 `cmd.exe /d /s /c "<原文>"` 才行。
4. **stdio 必须显式继承**。父进程的 stdout 常常是别人给的管道，句柄没打可继承标记，
   子进程就什么都拿不到：进程跑了、退出码也对，**一个字都没出来**。
   要 `SetHandleInformation(HANDLE_FLAG_INHERIT)` + `STARTF_USESTDHANDLES`。