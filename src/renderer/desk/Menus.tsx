// 右键菜单族（2026-11-14）：从 Desk.tsx 拆出。含定位 hook（useMenuPlacement）。
//
// 它们都只吃"坐标 + 回调 + 一条数据"，不碰 Sheet/Roster 的编排状态，所以可以整组搬。
// 菜单内部自己调 window.lynn.rpc（删除交付物、置顶群等），不经过 Desk 的 props 链。
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Icon, type IconName } from "../components/Icon";
import { STATUS_KEY, statusChipClass, type DeskJob, type DeskMember, type DeskOutput } from "./model";

/**
 * 右键菜单定位（2026-11-13）：默认在光标右下方展开；下方空间不够就翻到光标上方，
 * 否则菜单会溢出窗口底边、整块看不见。layout effect 在浏览器绘制前同步测量，无闪烁。
 */
export function useMenuPlacement(ref: RefObject<HTMLElement>, x: number, y: number, estW = 228, estH = 200) {
  const [style, setStyle] = useState<{ left: number; top: number }>(() => ({
    left: Math.max(8, Math.min(x, (window.innerWidth || 1200) - estW)),
    top: Math.max(8, Math.min(y, (window.innerHeight || 800) - 8)),
  }));
  useLayoutEffect(() => {
    const el = ref.current;
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    const w = el?.offsetWidth ?? estW;
    const h = el?.offsetHeight ?? estH;
    // 下方放不下就翻到光标上方：否则菜单溢出窗口底边，整块看不见（2026-11-13）
    const above = y + h > vh - 8;
    const top = above ? Math.max(8, y - h) : Math.min(y, Math.max(8, vh - h - 8));
    const left = Math.max(8, Math.min(x, vw - w - 8));
    setStyle({ left, top });
  }, [x, y, ref, estW, estH]);
  return style;
}

/**
 * 交付箱右键菜单（2026-11-13）：打开文件 / 打开所在目录 / 复制路径 / 查看所属 / 删除。
 *
 * 删除必须分清后果：**只移除记录**（文件还在）和**连文件一起删**是两件事，
 * 一句"删除"交代不了，所以第二段给两个明确按钮，不猜。
 */
export function OutputMenu({
  out,
  x,
  y,
  onClose,
  onOpen,
  onReveal,
  onInfo,
  onRemove,
}: {
  out: DeskOutput;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onInfo: () => void;
  onRemove: (deleteFile: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const name = out.abs.split(/[\\/]/).filter(Boolean).pop() ?? out.path;
  const style = useMenuPlacement(box, x, y, 248, 270);
  return createPortal(
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={name}>
      <div className="jobmenu-h">
        <Icon name="file" size="sm" />
        <span className="jobmenu-title" title={out.abs}>
          {name}
        </span>
      </div>
      <div className="jobmenu-sub mono" title={out.job.title}>
        {out.job.title}
      </div>
      {confirm ? (
        <>
          <p className="jobmenu-ask">「{name}」要怎么删？</p>
          <button type="button" className="jobmenu-item" onClick={() => onRemove(false)}>
            <Icon name="x" size="sm" />
            只从交付箱移除（文件保留）
          </button>
          <button type="button" className="jobmenu-item danger" onClick={() => onRemove(true)}>
            <Icon name="trash" size="sm" />
            连磁盘文件一起删
          </button>
          <button type="button" className="jobmenu-item" onClick={() => setConfirm(false)}>
            <Icon name="x" size="sm" />
            取消
          </button>
        </>
      ) : (
        <>
          <button type="button" className="jobmenu-item" onClick={onOpen}>
            <Icon name="file" size="sm" />
            打开文件
          </button>
          <button type="button" className="jobmenu-item" onClick={onReveal}>
            <Icon name="folder" size="sm" />
            打开所在目录
          </button>
          <button
            type="button"
            className="jobmenu-item"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(out.abs)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(onClose, 480);
                })
                .catch(() => setCopied(false));
            }}
          >
            <Icon name="clip" size="sm" />
            {copied ? "已复制" : "复制路径"}
          </button>
          <button type="button" className="jobmenu-item" onClick={onInfo}>
            <Icon name="info" size="sm" />
            查看所属
          </button>
          <button type="button" className="jobmenu-item danger" onClick={() => setConfirm(true)}>
            <Icon name="trash" size="sm" />
            删除…
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * 通用「文件」右键菜单（2026-11-13）：证据链、产物清单共用。
 *
 * 和交付箱那份的区别：这里只有"这个文件"能做的事——打开 / 定位 / 复制路径。
 * 「查看所属」「删除」是交付物才有的语义（交付物有归属、可移出交付箱），
 * 证据是"我核对过"的记录，不该给一个删除入口。
 */
export function RefMenu({
  taskId,
  fileRef,
  label,
  x,
  y,
  onClose,
  onOpen,
  onReveal,
  onCopied,
}: {
  taskId: string;
  fileRef: string;
  label?: string;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopied?: (msg: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const name = fileRef.split(/[\\/]/).filter(Boolean).pop() ?? fileRef;
  const style = useMenuPlacement(box, x, y, 248, 190);
  return createPortal(
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={name}>
      <div className="jobmenu-h">
        <Icon name="file" size="sm" />
        <span className="jobmenu-title" title={fileRef}>
          {name}
        </span>
      </div>
      {/* 说明行只在"和文件名不一样"时才出：一样就是同一句话说两遍 */}
      {label && label !== name && (
        <div className="jobmenu-sub" title={label}>
          {label}
        </div>
      )}
      <button type="button" className="jobmenu-item" onClick={onOpen}>
        <Icon name="file" size="sm" />
        打开文件
      </button>
      <button type="button" className="jobmenu-item" onClick={onReveal}>
        <Icon name="folder" size="sm" />
        打开所在目录
      </button>
      <button
        type="button"
        className="jobmenu-item"
        onClick={() => {
          // 绝对路径要主进程解析（渲染层只有卷宗内相对 ref）
          void window.lynn
            ?.rpc("app.resolveRef", { taskId, ref: fileRef })
            .then((r: { ok: boolean; path?: string; error?: string }) => {
              if (!r?.ok || !r.path) {
                setNote(r?.error ?? "解析路径失败");
                return;
              }
              void navigator.clipboard
                ?.writeText(r.path)
                .then(() => {
                  onCopied?.("已复制路径");
                  setNote("已复制");
                  window.setTimeout(onClose, 460);
                })
                .catch(() => setNote("复制失败（剪贴板不可用）"));
            });
        }}
      >
        <Icon name="clip" size="sm" />
        {note ?? "复制路径"}
      </button>
    </div>,
    document.body,
  );
}

/**
 * 工单卡右键菜单（2026-11-04）：
 * 卡住的单一度只能挂在台账里——「停」只 abort 成员、不改状态，「新对话」也不动后台。
 * 这里给四件事：打开 / 去出发会话 / 停成员 / 取消或删除（二次确认）。
 */
export function JobMenu({
  job,
  x,
  y,
  running,
  onClose,
  onOpen,
  onThread,
  onStop,
  onDismiss,
  onRemove,
  onGrantRead,
  onRevokeRead,
  onSnapshotProject,
  onExport,
}: {
  job: DeskJob;
  x: number;
  y: number;
  running: boolean;
  onClose: () => void;
  onOpen: () => void;
  onThread?: () => void;
  onStop?: () => void;
  onDismiss?: () => void;
  onRemove?: () => void;
  /** 只读授权（用户亲手选目录；写仍限工作区） */
  onGrantRead?: () => void;
  onRevokeRead?: () => void;
  /** 把工作区复制进任务沙箱再跑测试（原项目不动） */
  onSnapshotProject?: () => void;
  /** 导出卷宗 zip */
  onExport?: () => void;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState<null | "dismiss" | "remove">(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const done = job.status === "done" || job.status === "canceled";
  const style = useMenuPlacement(box, x, y, 240, 360);
  return (
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={job.id}>
      <div className="jobmenu-h">
        <Icon name="cube" size="sm" />
        {/* 菜单头也用任务名：工单号放下面一行小字，审计时再认 */}
        <span className="jobmenu-title" title={job.title}>
          {job.title}
        </span>
        <span className={`st ${statusChipClass(job)}`}>{t(STATUS_KEY[job.status] ?? "status.todo")}</span>
      </div>
      <div className="jobmenu-sub mono" title={t("tov.idHint")}>
        {job.id}
        {job.teamName ? ` · ${job.teamName}` : ""}
      </div>
      {confirm ? (
        <>
          <p className="jobmenu-ask">{confirm === "dismiss" ? t("menu.dismissAsk") : t("menu.removeAsk")}</p>
          <button
            type="button"
            className={`jobmenu-item${confirm === "remove" ? " danger" : ""}`}
            onClick={() => {
              if (confirm === "dismiss") onDismiss?.();
              else onRemove?.();
              onClose();
            }}
          >
            {t("menu.confirm")}
          </button>
          <button type="button" className="jobmenu-item" onClick={() => setConfirm(null)}>
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="jobmenu-item" onClick={onOpen}>
            <Icon name="eye" size="sm" />
            {t("menu.open")}
          </button>
          {onThread && (
            <button type="button" className="jobmenu-item" onClick={onThread}>
              <Icon name="send" size="sm" />
              {t("menu.thread")}
            </button>
          )}
          {onStop && (
            <button type="button" className="jobmenu-item" onClick={onStop}>
              <Icon name="stop" size="sm" />
              {t("menu.stop")}
            </button>
          )}
          {onGrantRead && (
            <button type="button" className="jobmenu-item" onClick={onGrantRead}>
              <Icon name="lock" size="sm" />
              {t("menu.grantRead")}
            </button>
          )}
          {onRevokeRead && (
            <button type="button" className="jobmenu-item" onClick={onRevokeRead}>
              <Icon name="eye" size="sm" />
              {t("menu.revokeRead")}
            </button>
          )}
          {onSnapshotProject && (
            <button type="button" className="jobmenu-item" onClick={onSnapshotProject}>
              <Icon name="cube" size="sm" />
              拷进任务沙箱跑测试…
            </button>
          )}
          {onExport && (
            <button type="button" className="jobmenu-item" onClick={onExport}>
              <Icon name="archive" size="sm" />
              导出卷宗 zip…
            </button>
          )}
          {!done && onDismiss && (
            <button type="button" className="jobmenu-item" onClick={() => setConfirm("dismiss")}>
              <Icon name="undo" size="sm" />
              {t("menu.dismiss")}
            </button>
          )}
          {!running && job.status !== "in_progress" && onRemove && (
            <button type="button" className="jobmenu-item danger" onClick={() => setConfirm("remove")}>
              <Icon name="trash" size="sm" />
              {t("menu.remove")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 成员右键菜单（群聊模式）：资料 / 目标 / 进度 / @他 / 催一下。
 * 形态照工单卡右键（JobMenu）：fixed 定位 + 点外面关闭 + Esc 关闭。
 */
export function MemberMenu({
  member,
  x,
  y,
  onClose,
  onProfile,
  onJob,
  onProgress,
  onAt,
  onNudge,
}: {
  member: DeskMember;
  x: number;
  y: number;
  onClose: () => void;
  onProfile: () => void;
  onJob: () => void;
  onProgress: () => void;
  onAt: () => void;
  onNudge: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const style = useMenuPlacement(box, x, y, 228, 240);
  const items: { label: string; icon: IconName; hint: string; on: () => void; off?: boolean }[] = [
    { label: "查看资料", icon: "user", hint: "岗位档案 · 战绩", on: onProfile },
    { label: "任务目标", icon: "target", hint: member.jobId ? "他被要求做什么" : "他手上没单", on: onJob, off: !member.jobId },
    { label: "进度", icon: "clock", hint: "最近在干什么 · 卷宗时间线", on: onProgress, off: !member.jobId },
    { label: "@他说话", icon: "at", hint: "插到输入框里", on: onAt },
    { label: "催一下", icon: "bell", hint: "话转给他，下一轮生效", on: onNudge, off: !member.jobId || member.status !== "running" },
  ];
  return (
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={member.name}>
      <div className="jobmenu-h">
        <Icon name="user" size="sm" />
        <span className="jobmenu-title">{member.name}</span>
        <span className="st">{member.role}</span>
      </div>
      <div className="jobmenu-sub mono">
        {member.teamName ?? member.teamId}
        {member.jobId ? ` · ${member.jobId}` : ""}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="jobmenu-item"
          disabled={it.off}
          title={it.hint}
          onClick={() => {
            if (it.off) return;
            it.on();
            onClose();
          }}
        >
          <Icon name={it.icon} size="sm" />
          {it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 群操作菜单（群列表）：置顶 / 改名 / 删除。
 * 一个入口就够——原来三个小图标散在行尾，越窄越挤，还占掉摘要的宽度。
 */
export function ThreadMenu({
  title,
  pinned,
  x,
  y,
  onClose,
  onPin,
  onRename,
  onDelete,
}: {
  title: string;
  pinned?: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const style = useMenuPlacement(box, x, y, 220, 150);
  return createPortal(
    <div className="jobmenu" ref={box} style={style} role="menu" aria-label={title}>
      <div className="jobmenu-h">
        <Icon name="list" size="sm" />
        <span className="jobmenu-title">{title}</span>
      </div>
      <button
        type="button"
        className="jobmenu-item"
        onClick={() => {
          onPin(!pinned);
          onClose();
        }}
      >
        <Icon name="pin" size="sm" />
        {pinned ? "取消置顶" : "置顶"}
      </button>
      <button
        type="button"
        className="jobmenu-item"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        <Icon name="pen" size="sm" />
        {t("ledger.threadRename")}
      </button>
      <button
        type="button"
        className="jobmenu-item danger"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <Icon name="trash" size="sm" />
        {t("ledger.threadDelete")}
      </button>
    </div>,
    document.body,
  );
}
