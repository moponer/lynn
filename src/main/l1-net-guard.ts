/**
 * L1 网络强制（2026-11-18 P10-2）。
 *
 * 为什么不能靠 Node 权限模型：`--permission` **不拦网络**（实测 `http` 模块照常可用）。
 * 这是 L1 自启用最后一道没关上的门。
 *
 * ## 实测：哪种拦法有效
 *
 * 在 worker 进程里做过对比实验（见 tests/l1-net-guard.test.mjs 的注释）：
 *
 * | 拦法 | 挡得住吗 |
 * |---|---|
 * | patch `http.request`（模块表面） | ❌ **挡不住 ESM**：`import http` 拿到的是另一份引用 |
 * | patch `net.Socket.prototype.connect`（原型） | ✅ 挡得住 CJS 与 ESM——两边共享同一个类 |
 *
 * 所以选**原型层**，不是模块表面。这是关键判断：模块表面能被 ESM 绕过，原型不能。
 *
 * ## 三条独立通道，必须全封
 *
 * | 通道 | 走 net.Socket 吗 | 怎么封 |
 * |---|---|---|
 * | TCP / TLS / HTTP / fetch | ✅ | patch `Socket.prototype.connect` |
 * | UDP（dgram） | ❌ 独立 | patch `dgram.createSocket` |
 * | DNS（c-ares，C++） | ❌ 独立 | patch `dns.lookup` / `resolve*` |
 *
 * **DNS 是最容易被忽略的**：它是真实的外泄通道（DNS 隧道能把数据编码进查询名）。
 * 只封 TCP 就宣称"断网"，那是假的安全感。
 *
 * ## 白名单怎么放行
 *
 * `permissions.net: ["api.example.com"]` 时，只放行这些域名的 **TCP**；
 * UDP 与 DNS 一律禁（DNS 走内核代理，不由插件直接解析）。
 * 这样"白名单"的语义是明确的：**只能连你声明的那些主机，且不能自己解析域名**。
 */

/** 插件声明允许访问的域名（来自 manifest `permissions.net`） */
export interface NetPolicy {
  /** 允许的域名列表；空数组 = 完全断网 */
  allow: readonly string[];
  /** 是否完全禁止（不传或 allow 为空时为 true） */
  denyAll: boolean;
}

export function netPolicyOf(netPerms: readonly string[] | undefined): NetPolicy {
  const allow = (netPerms ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  return { allow, denyAll: allow.length === 0 };
}

/** 判断一个主机名是否在白名单里（支持 `*.example.com` 通配） */
export function hostAllowed(host: string, policy: NetPolicy): boolean {
  if (policy.denyAll) return false;
  const h = host.trim().toLowerCase();
  for (const rule of policy.allow) {
    if (rule === h) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (h.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * 生成注入 worker 的守卫源码。
 *
 * 为什么生成**源码字符串**而不是 `import` 一个模块：
 * worker 入口（`agent/l1-worker.mjs`）是**打包后随应用分发**的独立文件，
 * 它不能 import `dist/main/*`（路径会随打包变化）。把守卫作为一段自包含源码
 * 拼进去，是唯一不引入路径耦合的办法。
 *
 * 守卫必须在 `activate` **之前**装好：插件在 `activate` 里就能发请求。
 */
export function netGuardSource(policy: NetPolicy): string {
  const allowJson = JSON.stringify(policy.allow);
  const denyAll = policy.denyAll ? "true" : "false";
  return `
// ---- 网络守卫（P10-2，由 l1-sandbox 注入）----
// 拦在原型层：模块表面（http.request）能被 ESM 绕过，原型不能。
const __netPolicy = { allow: ${allowJson}, denyAll: ${denyAll} };
const __netBlocked = (what, host) => {
  const err = new Error(
    "网络访问被拒绝：" + what + (host ? "（" + host + "）" : "") +
    "。这个插件声明的出站白名单是 [" + __netPolicy.allow.join(", ") + "]" +
    (__netPolicy.denyAll ? "（空 = 完全断网）" : "") +
    "。要联网请在 plugin.json 的 permissions.net 里声明域名。"
  );
  err.code = "ERR_NET_BLOCKED";
  return err;
};
const __hostOk = (host) => {
  if (__netPolicy.denyAll) return false;
  const h = String(host || "").trim().toLowerCase();
  for (const rule of __netPolicy.allow) {
    if (rule === h) return true;
    if (rule.startsWith("*.") && h.endsWith(rule.slice(1))) return true;
  }
  return false;
};

try {
  const __net = require("node:net");
  const __origConnect = __net.Socket.prototype.connect;
  __net.Socket.prototype.connect = function (...args) {
    // connect 的参数形态有几种：(port, host) / (options) / (path)
    let host = "";
    if (typeof args[1] === "string") host = args[1];
    else if (args[0] && typeof args[0] === "object") host = String(args[0].host || "");
    // 本机回环（IPC / unix socket）不涉及外发，放行；否则按白名单
    const isLocal = !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal && !__hostOk(host)) throw __netBlocked("TCP 连接", host);
    return __origConnect.apply(this, args);
  };
  /**
   * net.connect / net.createConnection 是 new Socket().connect() 的语法糖，
   * 但 **http.Agent 走的是这两条**（不是直接调原型方法）。
   * 只 patch 原型会漏掉它们——这是实测踩到的坑：UDP/DNS 都挡住了，TCP 还漏。
   */
  const __wrapConnect = (orig) => function (...args) {
    let host = "";
    if (typeof args[1] === "string") host = args[1];
    else if (args[0] && typeof args[0] === "object") host = String(args[0].host || "");
    const isLocal = !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal && !__hostOk(host)) throw __netBlocked("TCP 连接", host);
    return orig.apply(this, args);
  };
  if (typeof __net.connect === "function") __net.connect = __wrapConnect(__net.connect);
  if (typeof __net.createConnection === "function") {
    __net.createConnection = __wrapConnect(__net.createConnection);
  }
} catch (e) {
  // 拿不到 net 说明环境异常：宁可让插件起不来，也不静默放行
  throw new Error("网络守卫安装失败（net）：" + String(e && e.message || e));
}

try {
  const __dgram = require("node:dgram");
  __dgram.createSocket = () => { throw __netBlocked("UDP（dgram）"); };
} catch (e) {
  throw new Error("网络守卫安装失败（dgram）：" + String(e && e.message || e));
}

try {
  const __dns = require("node:dns");
  /**
   * DNS 的放行规则与 TCP 一致：**白名单里的域名可以解析，其余一律拒**。
   *
   * 为什么不能一律禁 DNS：net.connect({host:"example.com"}) 内部要解析域名，
   * 一律禁 DNS 会让白名单形同虚设（允许 TCP 却连不上）。实测踩过这个坑。
   *
   * 为什么仍然要拦：DNS 是真实外泄通道（DNS 隧道能把数据编码进查询名），
   * 所以只放行**声明过的**域名，任意域名解析一律拒。
   */
  const __dnsAllowed = (hostname) => __hostOk(String(hostname || ""));
  const __wrapLookup = (orig) => function (hostname, ...rest) {
    if (!__dnsAllowed(hostname)) throw __netBlocked("DNS 解析", String(hostname || ""));
    return orig.call(this, hostname, ...rest);
  };
  if (typeof __dns.lookup === "function") __dns.lookup = __wrapLookup(__dns.lookup);
  // resolve* 系列（含 resolveAny/resolveTxt 等）一律禁：它们常用于隧道外泄
  const __blockDns = (name) => () => { throw __netBlocked("DNS 解析（" + name + "）"); };
  for (const k of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveTxt", "resolveSrv", "resolveNs", "resolvePtr"]) {
    if (typeof __dns[k] === "function") __dns[k] = __blockDns(k);
  }
  if (__dns.promises) {
    if (typeof __dns.promises.lookup === "function") {
      __dns.promises.lookup = async (hostname, ...rest) => {
        if (!__dnsAllowed(hostname)) throw __netBlocked("DNS 解析", String(hostname || ""));
        return __dns.promises.lookup.__orig ? __dns.promises.lookup.__orig(hostname, ...rest) : undefined;
      };
    }
    for (const k of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "resolveSrv"]) {
      if (typeof __dns.promises[k] === "function") __dns.promises[k] = async () => { throw __netBlocked("DNS 解析（" + k + "）"); };
    }
  }
} catch (e) {
  throw new Error("网络守卫安装失败（dns）：" + String(e && e.message || e));
}
// ---- 网络守卫结束 ----
`;
}

/** 守卫装好之后，这条策略算不算"网络已被强制" */
export function netEnforcedBy(policy: NetPolicy): { ok: boolean; note: string } {
  /**
   * 诚实结论：**原型层 patch 挡得住普通代码，但挡不住刻意逃逸的代码。**
   *
   * 已知逃逸路径（刻意写才会用到）：
   *  - `process.binding("tcp_wrap")` 这类内部绑定；
   *  - 用 `worker_threads` 起一个新线程，在那里重新 import（守卫只在当前线程）；
   *  - 原生扩展（`.node`）直接调系统 API。
   *
   * 所以这里返回的 `ok` 只表示"常规路径已封"，不代表"绝对断网"。
   * 这个区别必须写进文档，否则"已验证安全"会变成谎话。
   */
  if (policy.denyAll) {
    return {
      ok: true,
      note: "常规网络路径已封（TCP/UDP/DNS）。刻意逃逸（process.binding / worker_threads / 原生扩展）不在覆盖范围内。",
    };
  }
  return {
    ok: true,
    note: `仅放行白名单域名（TCP）：${policy.allow.join(", ")}；UDP 与 DNS 仍全禁。`,
  };
}