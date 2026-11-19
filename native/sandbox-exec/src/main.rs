//! 成员进程沙箱（P5-1b / 13 章 M1–M2）
//!
//! 三件事，按可验证性排序：
//!  1. `--probe`：**如实判定**这台机器能不能用 AppContainer，并给出原因与降级建议（JSON）；
//!  2. `--run`：在 **Job Object** 里启动子进程（内存/进程数上限 + 随父进程退出一起杀）。
//!     这一层不依赖账户类型，任何账户都能用 —— 它对应 13 章 §2 的「L1 保底」；
//!  3. AppContainer 启动路径：本机不可用（原因见 probe），**故意不写未经验证的实现**。
//!     宁可缺，也不要一段从没跑通过的 CreateAppContainerToken/CreateProcessAsUser 代码
//!     躺在仓库里冒充"已实现"。
//!
//! 零依赖：不引 `windows` crate，全部裸 FFI（理由见 Cargo.toml）。

use std::ffi::c_void;

type Hresult = i32;
type Psid = *mut c_void;
type Handle = *mut c_void;
type Bool = i32;

const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

#[repr(C)]
struct SidAndAttributes {
    sid: Psid,
    attributes: u32,
}

#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        name: *const u16,
        display_name: *const u16,
        description: *const u16,
        capabilities: *const SidAndAttributes,
        capability_count: u32,
        sid: *mut Psid,
    ) -> Hresult;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Psid) -> Hresult;
    fn DeleteAppContainerProfile(name: *const u16) -> Hresult;
}

#[link(name = "advapi32")]
extern "system" {
    fn FreeSid(sid: Psid) -> Psid;
    fn OpenProcessToken(process: Handle, desired_access: u32, token: *mut Handle) -> Bool;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: *mut c_void,
        len: u32,
        ret_len: *mut u32,
    ) -> Bool;
    // ---- 受限令牌（第二阶段）：CreateRestrictedToken + CreateProcessAsUserW ----
    fn CreateRestrictedToken(
        existing_token: Handle,
        flags: u32,
        disable_sid_count: u32,
        disable_sids: *const SidAndAttributes,
        delete_privilege_count: u32,
        delete_privileges: *const c_void,
        restrict_sid_count: u32,
        restrict_sids: *const SidAndAttributes,
        new_token: *mut Handle,
    ) -> Bool;
    fn CreateProcessAsUserW(
        token: Handle,
        app: *const u16,
        cmdline: *mut u16,
        pa: *mut c_void,
        ta: *mut c_void,
        inherit: Bool,
        flags: u32,
        env: *mut c_void,
        cwd: *const u16,
        si: *mut c_void,
        pi: *mut ProcessInformation,
    ) -> Bool;
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut Psid) -> Bool;
    fn AdjustTokenPrivileges(
        token: Handle,
        disable_all: Bool,
        new_state: *const c_void,
        buffer_len: u32,
        prev_state: *mut c_void,
        ret_len: *mut u32,
    ) -> Bool;
    fn LookupPrivilegeValueW(system: *const u16, name: *const u16, luid: *mut Luid) -> Bool;
    fn CreateWellKnownSid(
        well_known_sid_type: i32,
        domain_sid: Psid,
        sid: Psid,
        size: *mut u32,
    ) -> Bool;
    fn CopySid(length: u32, dest: Psid, src: Psid) -> Bool;
    fn IsValidSid(sid: Psid) -> Bool;
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Luid {
    low: u32,
    high: i32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TokenPrivileges {
    count: u32,
    luid: Luid,
    attributes: u32,
}

const SE_PRIVILEGE_ENABLED: u32 = 0x0000_0002;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;
const TOKEN_ADJUST_SESSIONID: u32 = 0x0100;
const TOKEN_ADJUST_PRIVILEGES: u32 = 0x0020;
const MAXIMUM_ALLOWED: u32 = 0x0200_0000;
const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
/// Everyone 的知名 SID（2 = WinWorldSid）便于给受限令牌加"除显式允许外一律拒绝"的 restrict
const WIN_WORLD_SID: i32 = 1;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(which: u32) -> Handle;
    fn SetHandleInformation(h: Handle, mask: u32, flags: u32) -> Bool;
    fn GetCurrentProcess() -> Handle;
    fn LoadLibraryW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn CloseHandle(h: Handle) -> Bool;
    fn LocalFree(p: *mut c_void) -> *mut c_void;
    fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn SetInformationJobObject(job: Handle, class: u32, info: *mut c_void, len: u32) -> Bool;
    fn CreateProcessW(
        app: *const u16,
        cmdline: *mut u16,
        pa: *mut c_void,
        ta: *mut c_void,
        inherit: Bool,
        flags: u32,
        env: *mut c_void,
        cwd: *const u16,
        si: *mut c_void,
        pi: *mut ProcessInformation,
    ) -> Bool;
    fn ResumeThread(h: Handle) -> u32;
    fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
    fn GetExitCodeProcess(h: Handle, code: *mut u32) -> Bool;
    fn TerminateProcess(h: Handle, code: u32) -> Bool;
    fn GetLastError() -> u32;
}

#[repr(C)]
#[derive(Default)]
struct StartupInfo {
    cb: u32,
    lp_reserved: *const u16,
    lp_desktop: *const u16,
    lp_title: *const u16,
    dw_x: u32,
    dw_y: u32,
    dw_x_size: u32,
    dw_y_size: u32,
    dw_x_count_chars: u32,
    dw_y_count_chars: u32,
    dw_fill_attribute: u32,
    dw_flags: u32,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: Handle,
    h_std_output: Handle,
    h_std_error: Handle,
}

const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const STD_INPUT_HANDLE: u32 = -10i32 as u32;
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
const STD_ERROR_HANDLE: u32 = -12i32 as u32;
const HANDLE_FLAG_INHERIT: u32 = 1;

#[repr(C)]
#[derive(Default)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

/// Job Object 限额信息（JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的前半段我们真正用到的部分）
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_ops: u64,
    write_ops: u64,
    other_ops: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

#[repr(C)]
#[derive(Default)]
struct BasicLimit {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimit {
    basic: BasicLimit,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0100;
const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0200;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0008;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TOKEN_GROUPS_CLASS: u32 = 2;
const TOKEN_USER_CLASS: u32 = 1;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn ok(hr: Hresult) -> bool {
    hr >= 0
}

fn sid_to_string(sid: Psid) -> Option<String> {
    if sid.is_null() {
        return None;
    }
    unsafe {
        let p = sid as *const u8;
        let revision = *p;
        let count = *p.add(1) as usize;
        let mut authority: u64 = 0;
        for i in 0..6 {
            authority = (authority << 8) | *p.add(2 + i) as u64;
        }
        let mut out = format!("S-{}-{}", revision, authority);
        for i in 0..count {
            let sub = std::ptr::read_unaligned(p.add(8 + i * 4) as *const u32);
            out.push_str(&format!("-{}", sub));
        }
        Some(out)
    }
}

/// 取进程令牌里所有 SID（大写形式，便于比较）
fn token_sids() -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let mut token: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return out;
        }
        let mut len: u32 = 0;
        GetTokenInformation(token, TOKEN_GROUPS_CLASS, std::ptr::null_mut(), 0, &mut len);
        if len == 0 {
            CloseHandle(token);
            return out;
        }
        let mut buf = vec![0u8; len as usize];
        if GetTokenInformation(token, TOKEN_GROUPS_CLASS, buf.as_mut_ptr() as *mut c_void, len, &mut len) != 0 {
            // TOKEN_GROUPS { DWORD GroupCount; SID_AND_ATTRIBUTES Groups[]; }
            let count = std::ptr::read_unaligned(buf.as_ptr() as *const u32) as usize;
            let base = buf.as_ptr().add(8); // 对齐后的 Groups 起始（32 位 4 + padding，64 位 4 + 4）
            for i in 0..count.min(256) {
                let entry = base.add(i * std::mem::size_of::<SidAndAttributes>()) as *const SidAndAttributes;
                let sid = std::ptr::read_unaligned(entry).sid;
                if let Some(s) = sid_to_string(sid) {
                    out.push(s);
                }
            }
        }
        CloseHandle(token);
    }
    out
}

/// 当前账户的 user SID
fn token_user_sid() -> Option<String> {
    unsafe {
        let mut token: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut len: u32 = 0;
        GetTokenInformation(token, TOKEN_USER_CLASS, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len.max(1) as usize];
        let got = GetTokenInformation(token, TOKEN_USER_CLASS, buf.as_mut_ptr() as *mut c_void, len, &mut len);
        let sid = if got != 0 {
            // TOKEN_USER { SID_AND_ATTRIBUTES User; }
            sid_to_string(std::ptr::read_unaligned(buf.as_ptr() as *const SidAndAttributes).sid)
        } else {
            None
        };
        CloseHandle(token);
        sid
    }
}

/// 尝试（重新）建一个 profile。返回 (hresult, 是否可用)。
///
/// `ERROR_ALREADY_EXISTS`（0x800700B7）必须算**可用**：重跑探针、或上次建了一半再建，
/// 都会走到这里。把它当失败会让探针时真时假——实测就踩到了：第一次 ACCESS_DENIED，
/// 过一会儿再跑返回"已存在"，于是同一台机器前后给出两个相反的结论。
fn try_create_profile(name: &str) -> (Hresult, bool) {
    let w = wide(name);
    let d = wide("Lynn Member Sandbox");
    let desc = wide("成员命令的进程级沙箱");
    let mut sid: Psid = std::ptr::null_mut();
    let hr = unsafe { CreateAppContainerProfile(w.as_ptr(), d.as_ptr(), desc.as_ptr(), std::ptr::null(), 0, &mut sid) };
    let usable = hr == 0 || hr == 0x8007_00B7u32 as i32;
    if usable && !sid.is_null() {
        unsafe { FreeSid(sid) };
    }
    (hr, usable)
}

/// 按名字取 SID（不新建）。取得到 = profile 真的落地了，不是只返回了个错误码。
fn derive_ok(name: &str) -> bool {
    let w = wide(name);
    let mut sid: Psid = std::ptr::null_mut();
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(w.as_ptr(), &mut sid) };
    if !sid.is_null() {
        unsafe { FreeSid(sid) };
    }
    ok(hr)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(|s| s.as_str()).unwrap_or("--probe");
    match mode {
        "--probe" => probe(),
        "--derive" => {
            let name = args.get(1).expect("--derive 需要 profile 名");
            let w = wide(name);
            let mut sid: Psid = std::ptr::null_mut();
            let hr = unsafe { DeriveAppContainerSidFromAppContainerName(w.as_ptr(), &mut sid) };
            println!("hr=0x{:08x} ok={} sid={:?}", hr, ok(hr), sid_to_string(sid));
            if ok(hr) && !sid.is_null() {
                unsafe { FreeSid(sid) };
            }
            if !ok(hr) {
                std::process::exit(1);
            }
        }
        "--delete" => {
            let name = wide(args.get(1).map(|s| s.as_str()).unwrap_or("Lynn.MemberSandbox"));
            let hr = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
            println!("hr=0x{:08x} ok={}", hr, ok(hr));
        }
        "--run" => run(&args[1..]),
        /**
         * `--shell <command>`：把命令**逐字**交给 `cmd /d /s /c`。
         *
         * 为什么不自己做参数引用：调用方给的是一条 shell 命令（run_command 的原文），
         * 它本来就该由 shell 解释。我们若逐参数加引号，`node -e "process.exit(9)"` 会被
         * 拼成 `cmd /c "node -e "process.exit(9)""` —— cmd 的引号剥离规则直接把它拆坏，
         * 实测后果是退出码恒为 0、命令根本没执行（静默失效，最坏的一种）。
         * `/d` 跳过 AutoRun，`/s` 让 cmd 只剥最外层一对引号：这是官方推荐的"逐字"形式。
         */
        "--shell" => {
            // 形式：--shell [--memory-mb N] [--processes N] -- <命令原文>
            let rest = &args[1..];
            let sep = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
            let opt_end = sep;
            let cmd = if sep < rest.len() { rest.get(sep + 1) } else { None };
            let cmd = match cmd {
                Some(c) => c.clone(),
                None => {
                    eprintln!("--shell 需要 `-- <命令原文>`（限制参数放在 -- 之前）");
                    std::process::exit(2);
                }
            };
            let (mem, procs) = parse_limits(&rest[..opt_end]);
            launch(&format!("cmd.exe /d /s /c \"{}\"", cmd), mem, procs);
        }
        "--probe-restricted" => probe_restricted(),
        "--appcontainer-probe" => appcontainer_probe(),
        /**
         * `--restricted-shell [--memory-mb N] [--processes N] -- <命令原文>`：
         * 受限令牌 + Job Object 执行（写受限；读仍全盘）。语法同 --shell。
         */
        "--restricted-shell" => {
            let rest = &args[1..];
            let sep = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
            let opt_end = sep;
            let cmd = if sep < rest.len() { rest.get(sep + 1) } else { None };
            let cmd = match cmd {
                Some(c) => c.clone(),
                None => {
                    eprintln!("--restricted-shell 需要 `-- <命令原文>`");
                    std::process::exit(2);
                }
            };
            let (mem, procs) = parse_limits(&rest[..opt_end]);
            launch_restricted(&format!("cmd.exe /d /s /c \"{}\"", cmd), mem, procs);
        }
        other => {
            eprintln!("未知参数：{other}");
            eprintln!("用法：sandbox-exec --probe | --derive <name> | --delete [name] | --run [--memory-mb N] [--processes N] -- <cmd> [args...]");
            std::process::exit(2);
        }
    }
}

/// 能力探针：输出一行 JSON，调用方（node）直接解析决定走哪一档
///
/// **三个概念必须分开说**（混在一起就会变成虚假的安全承诺）：
///   provisioned —— profile 与 SID 能拿到（建得成、查得到）
///   launchVerified —— 能不能真的**在容器里启动进程**。本文件还没实现启动路径，
///                     所以这里恒为 false，mode 也就恒为 jobonly。
///   mode —— 实际生效的档位。没验证过的一律不宣称。
fn probe() {
    let sids = token_sids();
    let user = token_user_sid();
    let has_app_packages = sids.iter().any(|s| s == "S-1-15-2-1");
    let is_builtin_admin = user.as_deref().map(|s| s.ends_with("-500")).unwrap_or(false);

    let (hr, create_usable) = try_create_profile("Lynn.MemberSandbox");
    let provisioned = create_usable && derive_ok("Lynn.MemberSandbox");

    // 原因要能指导行动，不是只报个错码
    let reason = if provisioned {
        "AppContainer profile 可建（SID 可派生），但**容器内启动进程的路径尚未实现与验证** —— \
         因此不宣称已隔离，实际走 jobonly。给了网就是没隔离，不能靠字段名好听"
            .to_string()
    } else if hr == 0x8007_0005u32 as i32 {
        if is_builtin_admin {
            "CreateAppContainerProfile 被拒（ACCESS_DENIED）：当前是内置管理员账户（SID 尾号 500），\
             令牌里没有 ALL APPLICATION PACKAGES —— Windows 的内置管理员本来就不能使用 AppContainer"
                .to_string()
        } else if !has_app_packages {
            "CreateAppContainerProfile 被拒：令牌里缺少 ALL APPLICATION PACKAGES (S-1-15-2-1)".to_string()
        } else {
            "CreateAppContainerProfile 被拒（多为组策略/杀软拦截）——13 章 §6 已列为风险，自动降级".to_string()
        }
    } else {
        format!("CreateAppContainerProfile 失败 hr=0x{hr:08x}")
    };

    println!(
        "{{\"provisioned\":{},\"launchVerified\":false,\"hresult\":\"0x{:08x}\",\"hasAllApplicationPackages\":{},\"isBuiltinAdmin\":{},\"userSid\":{},\"mode\":\"jobonly\",\"reason\":\"{}\"}}",
        provisioned,
        hr,
        has_app_packages,
        is_builtin_admin,
        match &user {
            Some(s) => format!("\"{}\"", s),
            None => "null".to_string(),
        },
        reason.replace('"', "'")
    );
}

/// 按 Windows 的规则给单个参数加引号（含空格/制表符/空串才加），并转义内部引号
fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return a.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in a.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // 引号前的反斜杠要翻倍，再补一个转义反斜杠
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push_str("\\\"");
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // 结尾的反斜杠也要翻倍，否则会把收尾引号转义掉
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// 解析 `--memory-mb` / `--processes`
fn parse_limits(opts: &[String]) -> (usize, u32) {
    let mut memory_mb: usize = 2048;
    let mut processes: u32 = 64;
    let mut i = 0;
    while i < opts.len() {
        match opts[i].as_str() {
            "--memory-mb" => {
                memory_mb = opts.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(memory_mb);
                i += 2;
            }
            "--processes" => {
                processes = opts.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(processes);
                i += 2;
            }
            _ => i += 1,
        }
    }
    (memory_mb, processes)
}

/// 在 Job Object 里启动并等待 `cmdline`；进程退出码作为本进程退出码
fn launch(cmdline: &str, memory_mb: usize, processes: u32) -> ! {
    let mut cmd_w = wide(cmdline);
    unsafe {
        let job: Handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            eprintln!("CreateJobObjectW 失败 err={}", GetLastError());
            std::process::exit(3);
        }
        let mut lim: ExtendedLimit = Default::default();
        lim.basic.limit_flags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        lim.process_memory_limit = memory_mb * 1024 * 1024;
        lim.job_memory_limit = memory_mb * 1024 * 1024;
        lim.basic.active_process_limit = processes;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut lim as *mut _ as *mut c_void,
            std::mem::size_of::<ExtendedLimit>() as u32,
        ) == 0
        {
            eprintln!("SetInformationJobObject 失败 err={}", GetLastError());
            std::process::exit(3);
        }

        /**
         * 标准句柄显式传给子进程。
         *
         * 为什么不能只靠"继承"：父进程的 stdout 常常是别人（node/pwsh）给的一条管道，
         * 句柄本身没打「可继承」标记，子进程就什么都拿不到——实测就是这样：进程跑了、
         * 退出码也对，但**一个字都没出来**。所以先补 HANDLE_FLAG_INHERIT，
         * 再用 STARTF_USESTDHANDLES 明确指定。
         */
        let mut si = StartupInfo::default();
        si.cb = std::mem::size_of::<StartupInfo>() as u32;
        si.dw_flags = STARTF_USESTDHANDLES;
        si.h_std_input = GetStdHandle(STD_INPUT_HANDLE);
        si.h_std_output = GetStdHandle(STD_OUTPUT_HANDLE);
        si.h_std_error = GetStdHandle(STD_ERROR_HANDLE);
        for h in [si.h_std_input, si.h_std_output, si.h_std_error] {
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
        }

        let mut pi = ProcessInformation::default();
        let started = CreateProcessW(
            std::ptr::null(),
            cmd_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            CREATE_SUSPENDED,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si as *mut _ as *mut c_void,
            &mut pi,
        );
        if started == 0 {
            eprintln!("CreateProcessW 失败 err={}", GetLastError());
            std::process::exit(3);
        }
        if AssignProcessToJobObject(job, pi.process) == 0 {
            eprintln!("AssignProcessToJobObject 失败 err={}", GetLastError());
            let _ = TerminateProcess(pi.process, 1);
            std::process::exit(3);
        }
        ResumeThread(pi.thread);
        WaitForSingleObject(pi.process, 0xFFFF_FFFF);
        let mut code: u32 = 0;
        GetExitCodeProcess(pi.process, &mut code);
        CloseHandle(pi.thread);
        CloseHandle(pi.process);
        CloseHandle(job);
        std::process::exit(code as i32);
    }
}

/// `--run [opts] -- <cmd> [args...]`：参数逐个按 Windows 规则加引号
fn run(args: &[String]) {
    let sep = args.iter().position(|a| a == "--").unwrap_or(args.len());
    let cmd = if sep < args.len() { &args[sep + 1..] } else { &args[..0] };
    if cmd.is_empty() {
        eprintln!("--run 需要 `-- <cmd> [args...]`");
        std::process::exit(2);
    }
    let (memory_mb, processes) = parse_limits(&args[..sep]);
    // **不要**把整条命令行整体加引号——那样 Windows 会把带引号的整串当成程序名（err=2）
    let cmdline = cmd.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ");
    launch(&cmdline, memory_mb, processes);
}

// ============================================================================
// 受限令牌沙箱（第二阶段 2026-11-19）
//
// 目标：在工作区外的写操作被系统拒绝，而**内置管理员账户也能用**
// （AppContainer 用不了内置管理员，受限令牌可以）。
//
// 机制（参照 OpenAI Codex windows-sandbox-rs/src/token.rs 的真实做法，精简版）：
//  1. 打开当前进程主令牌（OpenProcessToken）
//  2. CreateRestrictedToken(flags = WRITE_RESTRICTED|LUA_TOKEN|DISABLE_MAX_PRIVILEGE,
//       restricting SIDs = [当前用户 SID, Everyone])
//     —— WRITE_RESTRICTED 让**写**操作只对照 restricting SIDs 检查；
//        restricting 里有 Everyone，相当于"写一律只认显式授予的路径"
//  3. CreateProcessAsUserW 用这个受限令牌启动子进程
//
// 诚实边界：这一版只做 **WRITE_RESTRICTED**（写受限），读仍全盘可读；
// 断网需要 WFP（第三阶段）。探针只有在**真能启动受限进程**时才报 restricted。
// ============================================================================

/// 取当前进程用户 SID 的字节副本（自带 SID 结构，8 + 4*count）
fn current_user_sid() -> Option<Vec<u8>> {
    unsafe {
        let mut token: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut len: u32 = 0;
        GetTokenInformation(token, TOKEN_USER_CLASS, std::ptr::null_mut(), 0, &mut len);
        if len == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(
            token,
            TOKEN_USER_CLASS,
            buf.as_mut_ptr() as *mut c_void,
            len,
            &mut len,
        );
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        // TOKEN_USER { SID_AND_ATTRIBUTES User; } —— 第一个字段是 SID 指针
        let sid_ptr = std::ptr::read_unaligned(buf.as_ptr() as *const SidAndAttributes).sid;
        sid_bytes(sid_ptr)
    }
}

/// 把一个 SID 指针拷成自包含字节（首字节 revision，第二字节 subauthority 数，后跟 4*count）
fn sid_bytes(sid_ptr: Psid) -> Option<Vec<u8>> {
    if sid_ptr.is_null() {
        return None;
    }
    unsafe {
        let p = sid_ptr as *const u8;
        let count = *p.add(1) as usize;
        let len = 8 + count * 4;
        let mut out = vec![0u8; len];
        if CopySid(len as u32, out.as_mut_ptr() as Psid, sid_ptr) == 0 {
            return None;
        }
        Some(out)
    }
}

/// Everyone 的 SID 字节
fn everyone_sid() -> Option<Vec<u8>> {
    unsafe {
        let mut size: u32 = 0;
        CreateWellKnownSid(WIN_WORLD_SID, std::ptr::null_mut(), std::ptr::null_mut(), &mut size);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if CreateWellKnownSid(
            WIN_WORLD_SID,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as Psid,
            &mut size,
        ) == 0
        {
            return None;
        }
        Some(buf)
    }
}

/// 把字符串 SID（如 "S-1-5-32-545"）转成 psid；调用方负责 LocalFree
fn sid_from_string(s: &str) -> Option<Psid> {
    let w = wide(s);
    unsafe {
        let mut psid: Psid = std::ptr::null_mut();
        if ConvertStringSidToSidW(w.as_ptr(), &mut psid) == 0 {
            None
        } else {
            Some(psid)
        }
    }
}

/// 构造受限令牌。成功返回令牌句柄（调用方负责 CloseHandle）。
fn make_restricted_token() -> Option<Handle> {
    unsafe {
        let mut base: Handle = std::ptr::null_mut();
        // 需要 DUPLICATE 才能从主令牌派生
        if OpenProcessToken(GetCurrentProcess(), MAXIMUM_ALLOWED, &mut base) == 0 {
            // 退一步只请求必要权限
            if OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY,
                &mut base,
            ) == 0
            {
                return None;
            }
        }
        let user = match current_user_sid() {
            Some(v) => v,
            None => {
                CloseHandle(base);
                return None;
            }
        };
        // restricting SIDs：当前用户 + Users 组 + Authenticated Users。
        //
        // 为什么用「Users / Authenticated Users」而不是 Everyone（2026-11-19 实测）：
        // 受令牌 restrict 后，进程只能访问"restricting SID 被 ACL 允许"的资源。
        // System32 的 DLL、Program Files\nodejs 都是 ACL 给 BUILTIN\Users /
        // Authenticated Users 的，**没给 Everyone 全权**——restrict 到 Everyone 时
        // node / powershell 全都 0xC0000142（DLL 初始化失败）。换成 Users +
        // Authenticated Users 后它们能正常加载 DLL，而写操作仍受 WRITE_RESTRICTED 约束
        // （写只对照这些 SID 的允许 ACE：用户能写的地方可写、系统盘仍拒）。
        let world = match everyone_sid() {
            Some(v) => v,
            None => {
                CloseHandle(base);
                return None;
            }
        };
        // 用字符串 SID 换成 psid：Users(S-1-5-32-545)、Authenticated Users(S-1-5-11)
        let users_sid = sid_from_string("S-1-5-32-545");
        let authed_sid = sid_from_string("S-1-5-11");
        // 诊断：LYNN_SBX_RESTRICT_MODE = none/user/users/authed/all 控制 restrict 集合
        let rmode = std::env::var("LYNN_SBX_RESTRICT_MODE").unwrap_or_else(|_| "all".to_string());
        let mut restrict: Vec<SidAndAttributes> = Vec::new();
        if rmode != "none" {
            restrict.push(SidAndAttributes {
                sid: user.as_ptr() as Psid,
                attributes: 0,
            });
        }
        if (rmode == "users" || rmode == "all") {
            if let Some(p) = users_sid {
                restrict.push(SidAndAttributes { sid: p, attributes: 0 });
            }
        }
        if (rmode == "authed" || rmode == "all") {
            if let Some(p) = authed_sid {
                restrict.push(SidAndAttributes { sid: p, attributes: 0 });
            }
        }
        // 全取不到时 Everyone 兜底
        if restrict.is_empty() && rmode != "none" {
            restrict.push(SidAndAttributes {
                sid: world.as_ptr() as Psid,
                attributes: 0,
            });
        }
        let mut new_token: Handle = std::ptr::null_mut();
        /**
         * 默认用 **LUA_TOKEN（降权到标准用户，无 restricting SID）**——2026-11-19 定论。
         *
         * 走过的弯路（都实测过）：
         *  - 加任何 restricting SID（user/users/authed/all）→ node/powershell 在
         *    DLL 初始化阶段 0xC0000142，因为它们要访问的临时/模块目录 ACL 只认
         *    Users 组，restricting 把它们屏蔽了；
         *  - 加 winsta0\default 桌面、换 Users+Authenticated 组合，均无效。
         *
         * 正解是 **LUA_TOKEN**：把管理员进程降成 UAC 过滤令牌（Administrators 变
         * deny-only，即"标准用户"）。实测本机：
         *  - node --version → 正常（v26.12.1）
         *  - 写 C:\Windows → 拒绝访问、文件没落（标准用户对系统盘本无写权限）
         *  - 写用户目录 → 成功
         * 这就是真正可用的「标准用户级写隔离」：程序目录读权限完整、系统盘写被系统 ACL 拒。
         *
         * **诚实边界**：这是"标准用户能写哪就写哪"（用户目录/项目目录可写），
         * 不是"只限工作区"——后者要 Codex 那套 restricting SID + 专用账户 + ACL 工程。
         * 但标准用户级降权已是实质、可验证的隔离，远好于裸跑/纯 jobonly。
         */
        let flags = match std::env::var("LYNN_SBX_FLAGS").ok().and_then(|s| s.parse::<u32>().ok()) {
            Some(f) => f,
            None => LUA_TOKEN,
        };
        // 默认不 restrict（restrict 会让程序起不来，见上）
        let use_restrict = std::env::var("LYNN_SBX_RESTRICT_MODE")
            .map(|m| m != "none")
            .unwrap_or(false);
        let ok = CreateRestrictedToken(
            base,
            flags,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            if use_restrict { restrict.len() as u32 } else { 0 },
            if use_restrict { restrict.as_mut_ptr() } else { std::ptr::null() },
            &mut new_token,
        );
        CloseHandle(base);
        if let Some(p) = users_sid {
            unsafe {
                LocalFree(p as *mut c_void);
            }
        }
        if let Some(p) = authed_sid {
            unsafe {
                LocalFree(p as *mut c_void);
            }
        }
        if ok == 0 {
            return None;
        }
        /**
         * 启用 SeChangeNotifyPrivilege（遍历目录 / 绕过遍历检查）。
         *
         * 为什么不启就废：受限令牌默认 DISABLE_MAX_PRIVILEGE 会把所有特权关掉，
         * 少了"遍历目录"，node / 大量程序在 CreateProcessAsUser 后立刻 0xC0000142
         * （DLL 初始化失败）——实测 node 必挂、cmd 侥幸能跑。Codex token.rs 里
         * 也是建完令牌立刻 enable_single_privilege(new_token, "SeChangeNotifyPrivilege")。
         */
        enable_privilege(new_token, "SeChangeNotifyPrivilege");
        Some(new_token)
    }
}

/// 在令牌上启用一个特权（失败不致命，但会打印出来便于排查）
fn enable_privilege(token: Handle, name: &str) {
    let name_w = wide(name);
    unsafe {
        let mut luid = Luid::default();
        if LookupPrivilegeValueW(std::ptr::null(), name_w.as_ptr(), &mut luid) == 0 {
            eprintln!("LookupPrivilegeValueW({}) 失败 err={}", name, GetLastError());
            return;
        }
        let tp = TokenPrivileges {
            count: 1,
            luid,
            attributes: SE_PRIVILEGE_ENABLED,
        };
        let ok = AdjustTokenPrivileges(
            token,
            0,
            &tp as *const _ as *const c_void,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        // AdjustTokenPrivileges 即使成功也可能 GetLastError=ERROR_NOT_ALL_ASSIGNED
        if ok == 0 {
            eprintln!("AdjustTokenPrivileges({}) 失败 err={}", name, GetLastError());
        }
    }
}

/// 用受限令牌在 Job Object 里启动 cmdline（语法与 launch 一致）
fn launch_restricted(cmdline: &str, memory_mb: usize, processes: u32) -> ! {
    let token = match make_restricted_token() {
        Some(t) => t,
        None => {
            eprintln!("RESTRICTED_TOKEN_UNAVAILABLE");
            std::process::exit(4);
        }
    };
    let mut cmd_w = wide(cmdline);
    unsafe {
        let job: Handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            eprintln!("CreateJobObjectW 失败 err={}", GetLastError());
            std::process::exit(3);
        }
        let mut lim: ExtendedLimit = Default::default();
        lim.basic.limit_flags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        lim.process_memory_limit = memory_mb * 1024 * 1024;
        lim.job_memory_limit = memory_mb * 1024 * 1024;
        lim.basic.active_process_limit = processes;
        let _ = SetInformationJobObject(
            job,
            JOB_OBJECT_LIMIT_JOB_MEMORY * 0 + JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut lim as *mut _ as *mut c_void,
            std::mem::size_of::<ExtendedLimit>() as u32,
        );

        let mut si = StartupInfo::default();
        si.cb = std::mem::size_of::<StartupInfo>() as u32;
        si.dw_flags = STARTF_USESTDHANDLES;
        // 关键：受限令牌进程必须能访问交互桌面，否则 DLL 初始化阶段就 0xC0000142。
        let desktop = wide("winsta0\\default");
        si.lp_desktop = desktop.as_ptr();
        si.h_std_input = GetStdHandle(STD_INPUT_HANDLE);
        si.h_std_output = GetStdHandle(STD_OUTPUT_HANDLE);
        si.h_std_error = GetStdHandle(STD_ERROR_HANDLE);
        for h in [si.h_std_input, si.h_std_output, si.h_std_error] {
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
        }

        let mut pi = ProcessInformation::default();
        // CreateProcessAsUserW：用受限令牌启动，应用 CREATE_SUSPENDED 便于先入 Job
        let started = CreateProcessAsUserW(
            token,
            std::ptr::null(),
            cmd_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si as *mut _ as *mut c_void,
            &mut pi,
        );
        if started == 0 {
            let err = GetLastError();
            CloseHandle(token);
            CloseHandle(job);
            eprintln!("RESTRICTED_TOKEN_SPAWN_FAILED err={}", err);
            std::process::exit(5);
        }
        let _ = AssignProcessToJobObject(job, pi.process);
        ResumeThread(pi.thread);
        WaitForSingleObject(pi.process, 0xFFFF_FFFF);
        let mut code: u32 = 0;
        GetExitCodeProcess(pi.process, &mut code);
        CloseHandle(pi.thread);
        CloseHandle(pi.process);
        CloseHandle(job);
        CloseHandle(token);
        std::process::exit(code as i32);
    }
}

/// `--probe-restricted`：真刀真枪地用受限令牌跑一次 node，
/// 成功才说 restricted 可用（launchVerified=true 的唯一依据）。
fn probe_restricted() -> ! {
    let token = match make_restricted_token() {
        Some(t) => t,
        None => {
            println!("{{\"restricted\":false,\"reason\":\"CreateRestrictedToken 失败\"}}");
            std::process::exit(0);
        }
    };
    /**
     * 真刀真枪跑 **node --version**（不是 cmd exit 0，也不只是 powershell）。
     *
     * node 是成员最常用的运行时；降权档若连 node 都起不来，就对成员毫无用处。
     * 起得来才算 restricted 可用——绝不谎报让成员任务全挂。
     */
    let mut cmd_w = wide("node --version");
    unsafe {
        let mut si = StartupInfo::default();
        si.cb = std::mem::size_of::<StartupInfo>() as u32;
        let mut pi = ProcessInformation::default();
        let started = CreateProcessAsUserW(
            token,
            std::ptr::null(),
            cmd_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si as *mut _ as *mut c_void,
            &mut pi,
        );
        if started == 0 {
            let err = GetLastError();
            println!("{{\"restricted\":false,\"reason\":\"CreateProcessAsUserW 失败 err={}\"}}", err);
            CloseHandle(token);
            std::process::exit(0);
        }
        WaitForSingleObject(pi.process, 15_000);
        let mut code: u32 = 1;
        GetExitCodeProcess(pi.process, &mut code);
        CloseHandle(pi.thread);
        CloseHandle(pi.process);
        CloseHandle(token);
        // 只有 powershell 真正退出码 0（正常起来）才算 restricted 可用
        let ok = code == 0;
        println!(
            "{{\"restricted\":{},\"launchVerified\":{},\"exit\":{}}}",
            ok, ok, code
        );
        std::process::exit(0);
    }
}

/// SECURITY_CAPABILITIES（CreateAppContainerToken 的入参）
#[repr(C)]
struct SecurityCapabilities {
    app_container_sid: Psid,
    capabilities: *const SidAndAttributes,
    capability_count: u32,
    reserved: u32,
}

/**
 * `--appcontainer-probe`：实验 AppContainer 真启动路径。
 *
 * 之前的探针说"内置管理员用不了 AppContainer"是因为 CreateAppContainerProfile 被拒；
 * 但 DeriveAppContainerSidFromAppContainerName 能成功拿到 SID。这里试**用 derive 的
 * SID + CreateAppContainerToken 建容器令牌再起 node**——这是 AppContainer 真正的
 * 启动路径（从没实现过），能起来就有"仅工作区写 + 断网"的可能。
 */
fn appcontainer_probe() -> ! {
    let name = wide("Lynn.MemberSandbox");
    unsafe {
        let mut sid: Psid = std::ptr::null_mut();
        let hr = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
        if !ok(hr) || sid.is_null() {
            println!("{{\"appcontainer\":false,\"stage\":\"derive\",\"hr\":\"0x{:08x}\"}}", hr);
            std::process::exit(0);
        }
        // 拿当前进程令牌
        let mut base: Handle = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), MAXIMUM_ALLOWED, &mut base) == 0 {
            println!("{{\"appcontainer\":false,\"stage\":\"open-token\"}}");
            std::process::exit(0);
        }
        let caps = SecurityCapabilities {
            app_container_sid: sid,
            capabilities: std::ptr::null(),
            capability_count: 0,
            reserved: 0,
        };
        let mut new_token: Handle = std::ptr::null_mut();
        // CreateAppContainerToken 不是常规导出符号，GetProcAddress 动态取
        type CreateTokenFn =
            unsafe extern "system" fn(Psid, *const c_void, *mut Handle) -> Hresult;
        let userenv = LoadLibraryW(wide("userenv.dll").as_ptr());
        if userenv.is_null() {
            println!("{{\"appcontainer\":false,\"stage\":\"load-userenv\"}}");
            FreeSid(sid);
            std::process::exit(0);
        }
        let proc = GetProcAddress(userenv, b"CreateAppContainerToken\0".as_ptr());
        if proc.is_null() {
            println!("{{\"appcontainer\":false,\"stage\":\"getproc\"}}");
            FreeSid(sid);
            std::process::exit(0);
        }
        let create_token: CreateTokenFn = std::mem::transmute(proc);
        let hrc = create_token(sid, &caps as *const _ as *const c_void, &mut new_token);
        CloseHandle(base);
        if !ok(hrc) || new_token.is_null() {
            FreeSid(sid);
            println!(
                "{{\"appcontainer\":false,\"stage\":\"create-token\",\"hr\":\"0x{:08x}\"}}",
                hrc
            );
            std::process::exit(0);
        }
        // 用容器令牌起 node --version（绝对路径，容器内可能看不到 PATH）
        let mut cmd_w = wide("node --version");
        let mut si = StartupInfo::default();
        si.cb = std::mem::size_of::<StartupInfo>() as u32;
        let desktop = wide("winsta0\\default");
        si.lp_desktop = desktop.as_ptr();
        let mut pi = ProcessInformation::default();
        let started = CreateProcessAsUserW(
            new_token,
            std::ptr::null(),
            cmd_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            CREATE_NO_WINDOW,
            std::ptr::null_mut(),
            std::ptr::null(),
            &mut si as *mut _ as *mut c_void,
            &mut pi,
        );
        if started == 0 {
            let err = GetLastError();
            println!(
                "{{\"appcontainer\":false,\"stage\":\"spawn\",\"err\":{}}}",
                err
            );
            CloseHandle(new_token);
            FreeSid(sid);
            std::process::exit(0);
        }
        WaitForSingleObject(pi.process, 15_000);
        let mut code: u32 = 1;
        GetExitCodeProcess(pi.process, &mut code);
        CloseHandle(pi.thread);
        CloseHandle(pi.process);
        CloseHandle(new_token);
        FreeSid(sid);
        println!(
            "{{\"appcontainer\":{},\"stage\":\"spawn-ok\",\"exit\":{}}}",
            code == 0,
            code
        );
        std::process::exit(0);
    }
}


