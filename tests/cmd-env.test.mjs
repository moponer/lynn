// 命令执行环境（2026-11-14）：成员命令的 env 不再直接继承 process.env。
//   ① 密钥类变量剔除（命令能 echo/node -e 读环境，出站闸拦不住脚本自己发请求）
//   ② 交互提示全关（git/npm 等凭据或分页器挂住 → 表现为"超时 120s"）
//   ③ 编码/CI 兜底，且都留逃生口
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandEnv, isSecretEnvName, posixToolDirs } from "../dist/main/cmd-env.js";

test("密钥类变量一律不带进命令环境", () => {
  const env = buildCommandEnv({
    PATH: "/usr/bin",
    DEEPSEEK_API_KEY: "sk-xxx",
    GITHUB_TOKEN: "ghp_xxx",
    AWS_SECRET_ACCESS_KEY: "aws",
    DB_PASSWORD: "p",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LYNN_DATA_ROOT: "C:/Users/x/.lynn",
  });
  assert.equal(env.PATH, "/usr/bin");
  for (const k of ["DEEPSEEK_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "SSH_AUTH_SOCK", "LYNN_DATA_ROOT"]) {
    assert.equal(env[k], undefined, `${k} 不该出现在命令环境里`);
  }
});

test("普通变量与代理保留（工具链依赖它们）", () => {
  const env = buildCommandEnv({
    PATH: "C:/Windows",
    USERPROFILE: "C:/Users/x",
    HTTP_PROXY: "http://127.0.0.1:7890",
    JAVA_HOME: "C:/jdk",
    KEYBOARD_LAYOUT: "us",
  });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.JAVA_HOME, "C:/jdk");
  // KEYBOARD 里含 KEY 但不是变量名边界上的 KEY，不能误伤
  assert.equal(env.KEYBOARD_LAYOUT, "us");
});

test("变量名边界判定：KEY/TOKEN 只在下划线或首尾才算凭据", () => {
  for (const yes of ["API_KEY", "OPENAI_API_KEY", "TOKEN", "MY_TOKEN", "SECRET", "AUTH"]) assert.equal(isSecretEnvName(yes), true, yes);
  for (const no of ["KEYBOARD_LAYOUT", "MONKEY", "TOKENS_PER_MIN", "AUTHOR", "SORT"]) assert.equal(isSecretEnvName(no), false, no);
});

test("交互提示被关掉，且覆盖用户设错的值", () => {
  const env = buildCommandEnv({ PAGER: "less", GIT_TERMINAL_PROMPT: "1", EDITOR: "vim", TERM: "xterm-256color" });
  assert.equal(env.PAGER, "cat");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.EDITOR, "true");
  assert.equal(env.GIT_SEQUENCE_EDITOR, "true");
  assert.equal(env.TERM, "dumb");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("CI 有默认值，也有两个逃生口", () => {
  assert.equal(buildCommandEnv({}).CI, "1");
  assert.equal(buildCommandEnv({ CI: "0" }).CI, "0", "用户显式设了就不覆盖");
  assert.equal(buildCommandEnv({ LYNN_BASH_NO_CI: "1" }).CI, undefined);
  assert.equal(buildCommandEnv({}, { noCi: true }).CI, undefined);
});

test("LANG 只在非 Windows 补，且不覆盖已有值", () => {
  const win = buildCommandEnv({}, { platform: "win32" });
  assert.equal(win.LANG, undefined);
  const lin = buildCommandEnv({}, { platform: "linux" });
  assert.equal(lin.LANG, "C.UTF-8");
  assert.equal(lin.LC_ALL, "C.UTF-8");
  assert.equal(buildCommandEnv({ LANG: "zh_CN.UTF-8" }, { platform: "linux" }).LANG, "zh_CN.UTF-8");
});

test("extra 可覆盖、可删除，undefined 值不落进环境", () => {
  const env = buildCommandEnv({ PATH: "C:/x", NODE_OPTIONS: "--max-old-space-size=4096" }, { extra: { PATH: "C:/bin", NODE_OPTIONS: undefined, HOME: "C:/h" } });
  assert.equal(env.PATH, "C:/bin");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, "C:/h");
  // base 里值为 undefined 的项也不落
  const env2 = buildCommandEnv({ FOO: undefined });
  assert.equal("FOO" in env2, false);
});

test("toolDirs 前置进 PATH，且认 Windows 的 Path 键名", () => {
  const env = buildCommandEnv(
    { Path: "C:\\Windows;C:\\Windows\\System32" },
    { toolDirs: ["C:\\Program Files\\Git\\usr\\bin"], platform: "win32" },
  );
  assert.equal(env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Windows;C:\\Windows\\System32");
  assert.equal(env.PATH, undefined, "不能凭空多出一个 PATH 变量（Windows 上会变成两条路径）");
  // 不传就不动 PATH
  assert.equal(buildCommandEnv({ PATH: "/usr/bin" }, { platform: "linux" }).PATH, "/usr/bin");
});

test("posixToolDirs：注入 exists 才判断，顺序是 自备 → 自带 → Git，且去重", () => {
  const exists = (p) => p === "C:\\mine" || /Git[\\/]usr[\\/]bin/i.test(p);
  const dirs = posixToolDirs(
    { ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\LA", LYNN_POSIX_TOOLS: "C:\\mine" },
    exists,
    "win32",
  );
  assert.equal(dirs[0], "C:\\mine", "用户自备的排最前");
  assert.ok(dirs.includes("C:\\PF\\Git\\usr\\bin"));
  assert.ok(dirs.includes("C:\\LA\\Programs\\Git\\usr\\bin"));
  assert.equal(new Set(dirs).size, dirs.length, "同一个目录不能重复");
  // 非 Windows 不做任何 PATH 注入
  assert.deepEqual(posixToolDirs({}, () => true, "linux"), []);
});
