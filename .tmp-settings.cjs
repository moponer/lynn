
const fs = require('fs');
const FILE = 'src/renderer/components/SettingsModal.tsx';
let src = fs.readFileSync(FILE, 'utf8');
const log = [];
function rep(oldS, newS, label) {
  if (!src.includes(oldS)) { log.push('MISS ' + label); return; }
  src = src.split(oldS).join(newS);
  log.push('ok ' + label);
}

// ---- 危险动作：加 .danger 变体 ----
// 删除模型
rep(
`<button type="button" className="sf-btn" onClick={() => void actOnModel("remove", m.id)} disabled={busy !== ""}>删除</button>`,
`<button type="button" className="sf-btn danger" onClick={() => void actOnModel("remove", m.id)} disabled={busy !== ""}>
                        {t("common.delete")}
                      </button>`, 'model-remove');

// 解散团队
rep(
`                  <button
                    type="button"
                    className="sf-btn"
                    disabled={teamBusy}
                    onClick={() => {
                      const key = \`dissolve:\${tm.id}\`;`,
`                  <button
                    type="button"
                    className="sf-btn danger"
                    disabled={teamBusy}
                    onClick={() => {
                      const key = \`dissolve:\${tm.id}\`;`, 'team-dissolve');

// 移出成员
rep(
`                        <button
                          type="button"
                          className="sf-btn"
                          disabled={teamBusy || tm.status !== "active"}
                          onClick={() => {
                            if (teamPending !== key) {`,
`                        <button
                          type="button"
                          className="sf-btn danger"
                          disabled={teamBusy || tm.status !== "active"}
                          onClick={() => {
                            if (teamPending !== key) {`, 'member-remove');

// 清理过程文件
rep(
`              <button
                type="button"
                className="sf-btn"
                onClick={() => {
                  setDataMsg("");
                  void window.lynn
                    .rpc("data.cleanup", {})`,
`              <button
                type="button"
                className="sf-btn danger"
                onClick={() => {
                  setDataMsg("");
                  void window.lynn
                    .rpc("data.cleanup", {})`, 'data-cleanup');

// 清空会话
rep(
`            <button
              type="button"
              className="sf-btn"
              onClick={() => {
                void (async () => {
                  const ok = await askConfirm({
                    title: t("data.clearSession"),`,
`            <button
              type="button"
              className="sf-btn danger"
              onClick={() => {
                void (async () => {
                  const ok = await askConfirm({
                    title: t("data.clearSession"),`, 'clear-session');

// 删除自动化任务
rep(
`                      <button type="button" className="sf-btn" disabled={autoBusy} onClick={() => void removeSchedule(s.id, s.name)}>`,
`                      <button type="button" className="sf-btn danger" disabled={autoBusy} onClick={() => void removeSchedule(s.id, s.name)}>`, 'schedule-remove');

// ---- 行内 style 的 checkbox 行 -> .check-row 原语 ----
rep(
`            <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={gwRiskAck} onChange={(e) => setGwRiskAck(e.target.checked)} style={{ marginTop: 3 }} />
              <span className="sf-hint">
                我了解：本机/局域网网关可能复用第三方免费额度、prompt 可能被上游记录，且随时限流或下线；只会在非敏感数据上使用。
              </span>
            </label>`,
`            <label className="check-row">
              <input type="checkbox" checked={gwRiskAck} onChange={(e) => setGwRiskAck(e.target.checked)} />
              <span>{t("model.gwRisk")}</span>
            </label>`, 'gw-risk');

rep(
`                <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={riskAck}
                    onChange={(e) => setRiskAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span className="sf-hint">`,
`                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={riskAck}
                    onChange={(e) => setRiskAck(e.target.checked)}
                  />
                  <span>`, 'risk-ack');

rep(
`                <label className="sf-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={plaintextAck}
                    onChange={(e) => setPlaintextAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span className="sf-hint">`,
`                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={plaintextAck}
                    onChange={(e) => setPlaintextAck(e.target.checked)}
                  />
                  <span>`, 'plaintext-ack');

// ---- 行内宽度 -> 类名 ----
rep(`style={{ width: 150 }}`, `style={{ width: "var(--w-input-sm)" }}`, 'w150');
rep(`style={{ width: 200 }}`, `style={{ width: "var(--w-input-md)" }}`, 'w200');
rep(`style={{ width: 80 }}`, `style={{ width: "var(--w-input-xs)" }}`, 'w80');
rep(`style={{ width: 160 }}`, `style={{ width: "var(--w-input-sm)" }}`, 'w160');
rep(`style={{ width: 100 }}`, `style={{ width: "var(--w-input-xs)" }}`, 'w100');

fs.writeFileSync(FILE, src);
console.log(log.join('\n'));
