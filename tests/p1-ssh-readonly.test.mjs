// ssh_run 只读白名单：首命令收口 + 全串连接符拒绝 + 写动作子参数封堵。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sshReadOnlyCommandError } from "../dist/main/kernel.js";

test("常见只读排查命令放行", () => {
  const allowed = [
    "ls -la /var/log",
    "ps aux",
    "df -h",
    "cat /var/log/syslog",
    "head -n 20 app.log",
    "tail -n 50 app.log",
    "grep -n error app.log",
    "find /var/log -name \"*.log\"",
    "stat app.log",
    "journalctl -n 50 --no-pager",
    "systemctl status ssh",
    "top -b -n 1",
    "ip addr show",
    "sort -u app.log",
    "ss -lntup",
    "mount -l",
  ];
  for (const command of allowed) assert.equal(sshReadOnlyCommandError(command), null, command);
});

test("重定向、命令替换、多命令、管道与后台执行全串拒绝", () => {
  const denied = [
    "cat app.log > copy.log",
    "cat `which sh`",
    "cat $(which sh)",
    "cat <(printf x)",
    "ls; ps",
    "ls && ps",
    "ls || ps",
    "ls | grep x",
    "ls &",
    "ls\nps",
  ];
  for (const command of denied) assert.match(sshReadOnlyCommandError(command), /拒绝执行/, command);
});

test("非白名单首命令与 systemctl/top/mount 的越权形态拒绝", () => {
  for (const command of ["rm -rf /tmp/x", "sudo ls", "python -c pass", "reboot", "echo hi"]) {
    assert.match(sshReadOnlyCommandError(command), /只读白名单/, command);
  }
  assert.match(sshReadOnlyCommandError("systemctl restart ssh"), /只允许 status/);
  assert.match(sshReadOnlyCommandError("systemctl"), /只允许 status/);
  assert.match(sshReadOnlyCommandError("top"), /只允许 -b/);
  assert.match(sshReadOnlyCommandError("mount /dev/sda1 /mnt"), /只允许无参数或 -l/);
});

test("find/sort/ip/journalctl/ss 的删除、执行与写文件参数拒绝", () => {
  const denied = [
    ["find /tmp -delete", /-delete/],
    ["find /tmp -exec ls {} +", /-delete\/-exec/],
    ["find /tmp -fprintf out.txt %p", /-fprintf/],
    ["sort -o sorted.txt app.log", /-o\/--output/],
    ["sort --output=sorted.txt app.log", /-o\/--output/],
    ["ip netns exec ns1 ls", /netns exec/],
    ["ip link set eth0 down", /只允许 show\/list\/get/],
    ["journalctl --vacuum-size=1G", /只允许查询日志/],
    ["journalctl --rotate", /只允许查询日志/],
    ["ss -K dst 10.0.0.1", /不允许 -K\/--kill/],
  ];
  for (const [command, pattern] of denied) assert.match(sshReadOnlyCommandError(command), pattern, command);
});
