// 命令面板与快捷键总览（2026-11-14）：从 Desk.tsx 拆出。
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { fmtTime } from "./model";
import type { Desk } from "./model";

// ============================ COMMAND PALETTE (E6) ============================

export type CmdItem = { key: string; group: string; label: string; hint?: string; run: () => void };

/** Ctrl+K：跳工单 / 会话 / 动作。键盘上下选择，Enter 执行。 */
export function CommandPalette({
  desk,
  onClose,
  onSelectJob,
  onThread,
  onOpenSettings,
  onStandby,
  onNew,
  onPickProject,
  onClearWorkspace,
  onAddReadRoots,
}: {
  desk: Desk;
  onClose: () => void;
  onSelectJob: (id: string) => void;
  onThread?: (id: string) => void;
  onOpenSettings: () => void;
  onStandby: () => void;
  onNew?: () => void;
  onPickProject?: () => void;
  onClearWorkspace?: () => void;
  onAddReadRoots?: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const items = useMemo<CmdItem[]>(() => {
    const list: CmdItem[] = [];
    for (const j of desk.jobs) {
      list.push({ key: `job:${j.id}`, group: t("cmdk.jobs"), label: `${j.id} · ${j.title}`, run: () => onSelectJob(j.id) });
    }
    for (const th of desk.threads) {
      list.push({ key: `th:${th.id}`, group: t("cmdk.threads"), label: th.title, hint: fmtTime(th.updatedAt), run: () => onThread?.(th.id) });
    }
    list.push(
      { key: "a:new", group: t("cmdk.actions"), label: t("cmdk.newThread"), run: () => onNew?.() },
      { key: "a:settings", group: t("cmdk.actions"), label: t("cmdk.settings"), run: () => onOpenSettings() },
      { key: "a:standby", group: t("cmdk.actions"), label: t("cmdk.standby"), run: () => onStandby() },
      { key: "a:workdir", group: "工作区", label: "换工作区…", run: () => onPickProject?.() },
      { key: "a:nowork", group: "工作区", label: "这次不用工作区", run: () => onClearWorkspace?.() },
      { key: "a:readroot", group: "工作区", label: "加只读目录…", run: () => onAddReadRoots?.() },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.jobs, desk.threads, t]);
  const filtered = q.trim() ? items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) : items;
  const sel = Math.min(idx, Math.max(0, filtered.length - 1));

  useEffect(() => {
    // capture：面板开着时键盘事件在这里先处理，不吃到底层
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        filtered[sel]?.run();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, sel, onClose]);

  // 分组保持 jobs → threads → actions 顺序
  const groups: { name: string; items: CmdItem[] }[] = [];
  for (const it of filtered) {
    const g = groups.find((x) => x.name === it.group);
    if (g) g.items.push(it);
    else groups.push({ name: it.group, items: [it] });
  }
  let flat = -1;

  return (
    <div className="cmdk-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label={t("cmdk.title")}>
        <div className="cmdk-inrow">
          <Icon name="search" size="sm" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            placeholder={t("cmdk.placeholder")}
          />
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-empty">{t("cmdk.empty")}</div>}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="cmdk-grp">{g.name}</div>
              {g.items.map((it) => {
                flat += 1;
                const on = flat === sel;
                return (
                  <button
                    type="button"
                    key={it.key}
                    className={`cmdk-item${on ? " on" : ""}`}
                    onMouseEnter={() => setIdx(filtered.indexOf(it))}
                    onClick={() => {
                      it.run();
                      onClose();
                    }}
                  >
                    <span className="l">{it.label}</span>
                    {it.hint && <span className="hint mono">{it.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Ctrl+/：快捷键清单（截图键从壳层实况读，改键后不漂移） */
export function KeymapOverlay({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [captureKey, setCaptureKey] = useState("Alt+Shift+S");
  useEffect(() => {
    let dead = false;
    void window.lynn
      .rpc("capture.status")
      .then((r) => {
        if (!dead && r?.hotkey) setCaptureKey(r.hotkey);
      })
      .catch(() => {
        /* 拿不到就显示默认键，不阻塞面板 */
      });
    return () => {
      dead = true;
    };
  }, []);
  const rows: { k: string; d: string }[] = [
    { k: "Ctrl+K", d: t("keymap.palette") },
    { k: "Ctrl+/", d: t("keymap.keymap") },
    { k: "Ctrl+.", d: t("keymap.standby") },
    { k: "Alt+Shift+L", d: t("keymap.global") },
    { k: captureKey, d: t("keymap.capture") },
    { k: "Esc", d: t("keymap.close") },
    { k: "Enter", d: t("keymap.send") },
    { k: "Shift+Enter", d: t("keymap.newline") },
    { k: "@", d: t("keymap.mention") },
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="cmdk-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label={t("keymap.title")}>
        <div className="cmdk-head">{t("keymap.title")}</div>
        <div className="cmdk-list">
          {rows.map((r) => (
            <div className="keymap-row" key={r.k}>
              <span className="mono">{r.k}</span>
              <span>{r.d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
