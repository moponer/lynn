# 发布与签名（现状如实说明）

## 安装包

```bash
npm run dist   # electron-builder → release/Lynn-<version>-setup.exe（NSIS，x64）
```

- asar 已关闭（RPC 子进程需要真文件路径加载 Pi ESM 包，体积换稳定）。
- 应用数据目录 `~/.lynn` 独立于安装目录，升级 / 卸载不清数据。

## 签名（未做，如实注明）

- 当前安装包**未做代码签名**——Windows SmartScreen 可能提示「未知发布者」。这是发布流程尚未接入证书（OV/EV），不是技术阻塞；接入后本节会更新。
- 更新器（electron-updater）走 generic feed：默认禁用自动下载，`LYNN_UPDATE_FEED` 或 `~/.lynn/updater.json` 可指定源；签名接入前请自行核验安装包来源。

## 合规文本

- 许可：仓库根 [`LICENSE`](../../../LICENSE)（MIT）。
- 第三方：[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md)（直接依赖手写标注 + 440 包清单由 `node scripts/gen-notices.mjs` 自动生成）。
- 隐私：[隐私说明](./privacy.md)（与实现同步，不夸大隔离）。

## 发布核对单

- [ ] `npm run typecheck && npm test && npm run lint:design` 全绿
- [ ] `npm run build` 后 `npm run dist` 产出安装包
- [ ] `node scripts/gen-notices.mjs` 重跑，依赖清单与 package-lock 一致
- [ ] 隐私说明的「更新于」日期与功能变化同步
- [ ] （签名接入后）SmartScreen 验证 + 更新器 sha512 校验说明
