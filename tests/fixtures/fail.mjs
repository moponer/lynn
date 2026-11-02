// 立刻以非零码退出：验证「装之前先试装」能拦住失败插件
console.error("boom: this plugin fails on load");
process.exit(3);
