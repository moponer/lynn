// messaging.json 与 settings.json 同一权限纪律：新建 0600，旧文件保存后收紧。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMessaging, saveMessaging } from "../dist/main/messaging.js";

test("saveMessaging：新文件 0600，已存在的过宽权限保存后收紧", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows NTFS 不使用 POSIX mode 位");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-p1-message-mode-"));
  const file = path.join(root, "messaging.json");
  saveMessaging(root, { feishu: { appId: "cli_test", secret: { encrypted: true, data: "cipher" }, enabled: true, updatedAt: "now" } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadMessaging(root).feishu.appId, "cli_test");

  fs.chmodSync(file, 0o644);
  saveMessaging(root, { qq: { appId: "qq_test", secret: { encrypted: true, data: "cipher2" }, enabled: false, updatedAt: "later" } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadMessaging(root).qq.appId, "qq_test");
});
