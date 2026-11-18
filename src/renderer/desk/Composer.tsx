// 底部指令台（2026-11-14）：从 Desk.tsx 拆出。
//
// 它只吃"当前权限档 + 回调 + 忙闲"，自己持有输入框草稿、@ 候选、截图状态。
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../components/Icon";
import { Slot, SandboxAction, useUiPlugins } from "./ui-host";
import { UsageMeter } from "../components/UsageMeter";
import { useTick } from "./use-tick";
import type { CaptureShot, QueueItem, UsageView } from "../../shared/contract";
import type { Desk } from "./model";

export function ComposerZone({
  configured,
  turn,
  queue,
  variant = "desk",
  onStandby,
  onSend,
  onFileSearch,
  onAbort,
  onQueue,
  captureShot,
  members,
  pendingAt,
  usage,
  tokensUsed,
  initialDraft,
  onDraftChange,
}: {
  configured: boolean;
  turn: Desk["turn"];
  queue: QueueItem[];
  variant?: "desk" | "review";
  onStandby?: () => void;
  /**
   * 发送结果约定：null = 成功，字符串 = 失败原因。
   * 输入台等这个结果回来才清草稿/随附——失败时原样保留，用户改完能直接重发。
   */
  onSend: (
    text: string,
    mode: "queue" | "steer",
    attachments?: { files?: string[]; images?: { name: string; data: string }[] },
  ) => void | Promise<string | null>;
  /** @ 提及的项目文件检索（M1-16） */
  onFileSearch?: (q: string) => Promise<{ path: string; size: number }[]>;
  onAbort: () => void;
  onQueue: (action: "clear" | "remove", id?: string) => void;
  /** 全局快捷键截好的图：按 id 注入本轮随附，用户自己决定发不发 */
  captureShot?: CaptureShot | null;
  /** 群里可点名的人（本群成员排前面，由 DeskView 排好序） */
  members?: { name: string; role?: string }[];
  /** 右键成员「@他说话」：把名字插进输入框 */
  pendingAt?: { name: string; nonce: number } | null;
  /** 会话用量（顶栏用量计与这里共用同一套口径） */
  usage: UsageView;
  tokensUsed: number;
  /**
   * 文字草稿按会话隔离（产品行为）：DeskView 按会话 key 重建输入台，
   * 文字草稿从草稿匣取回、变化时写回——切走再切回来还能接着写；
   * @ 文件与图片附件不走这个匣子，切会话即随组件卸载清空（不跨会话误发）。
   */
  initialDraft?: string;
  onDraftChange?: (draft: string) => void;
}) {
  /** P9-1：插件崩了要能一键停用（卡槽里的错误卡会用到） */
  const { toggle: toggleUi } = useUiPlugins();
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const busy = turn.busy;
  const now = useTick(busy && Boolean(turn.activity));
  const elapsed = turn.activityAt ? Math.max(0, Math.floor((now - turn.activityAt) / 1000)) : 0;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const t = useT();
  // 本轮随附（M1-16）：发送前可见、逐片可裁剪
  const [attFiles, setAttFiles] = useState<string[]>([]);
  const [attImages, setAttImages] = useState<{ name: string; data: string }[]>([]);
  // @ 补全：群里的人（成员）+ 项目文件
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** @ 文件补全请求序号：只接受最后一次查询的响应，旧响应一律丢弃 */
  const fileSeq = useRef(0);
  const imgSeq = useRef(0);
  const lastShot = useRef<string | null>(null);
  const [captureErr, setCaptureErr] = useState<string | null>(null);
  /** 发送中：等 onSend 结果期间防重复提交（Enter 连打也只发一次） */
  const [sending, setSending] = useState(false);
  /** 发送失败原因：草稿与随附原样保留，错误落在输入台而不是被吞掉 */
  const [sendErr, setSendErr] = useState<string | null>(null);
  const hasAtt = attFiles.length > 0 || attImages.length > 0;
  const canSend = (draft.trim().length > 0 || hasAtt) && configured;

  // 文字草稿写回会话草稿匣：附件不进匣子（产品行为见 props 注释）
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  /** 让在途的文件补全失效并清掉定时器：新查询/退出 @/选中/卸载都走这一个口 */
  const invalidateFileSearch = () => {
    fileSeq.current += 1;
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
  };

  // 卸载：清定时器 + 在途响应作废，晚了到的响应不再 setState
  useEffect(() => () => invalidateFileSearch(), []);

  // 截图进随附条：与粘贴图片同一条可见链；按 id 去重，StrictMode 双跑也不会加两片
  useEffect(() => {
    if (!captureShot || lastShot.current === captureShot.id) return;
    lastShot.current = captureShot.id;
    setAttImages((imgs) => [...imgs, { name: captureShot.name, data: captureShot.data }]);
    taRef.current?.focus();
  }, [captureShot]);

  // 右键成员「@他说话」：把 @名字 插进草稿（群聊模式的定向入口）
  useEffect(() => {
    if (!pendingAt) return;
    setDraft((d) => `${d && !/\s$/.test(d) ? `${d} ` : d}@${pendingAt.name} `);
    taRef.current?.focus();
  }, [pendingAt?.nonce]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,80})$/.exec(before);
    if (m) {
      const q = m[2];
      const start = caret - q.length - 1;
      setMention({ start, q });
      setMentionIdx(0);
      // 群里的人优先：他就在眼前，比翻文件路径更可能是想要的
      const people = (members ?? [])
        .filter((mm) => (q ? mm.name.includes(q) || q.includes(mm.name) : true))
        .slice(0, 8)
        .map((mm) => ({ kind: "member" as const, name: mm.name, role: mm.role }));
      if (people.length) {
        // 成员候选直接出：不再需要文件查询，在途响应一并作废
        invalidateFileSearch();
        setMentionItems(people);
        return;
      }
      if (!onFileSearch) {
        invalidateFileSearch();
        setMentionItems([]);
        return;
      }
      invalidateFileSearch();
      const seq = fileSeq.current;
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null;
        onFileSearch(q)
          .then((files) => {
            // 只接受最后一次查询：旧查询的响应覆盖新候选是补全最常见的错乱
            if (seq !== fileSeq.current) return;
            setMentionItems(files.map((f) => ({ kind: "file" as const, path: f.path, size: f.size })));
          })
          .catch(() => {
            // 检索失败就当没有候选：不能留一个未处理 rejection，也不清空现有输入
          });
      }, 200);
    } else {
      // 退出 @：候选收起来的同时，在途响应与定时器一起作废
      invalidateFileSearch();
      setMention(null);
      setMentionItems([]);
    }
  };

  const pickMention = (p: MentionItem) => {
    if (!mention) return;
    if (p.kind === "member") {
      // 成员 @ 留在正文里：这才是"对某个人说的话"，摘掉就丢了定向语义
      setDraft((d) => d.slice(0, mention.start) + `@${p.name} ` + d.slice(mention.start + mention.q.length + 1));
    } else {
      // 文件：从草稿里摘掉 @token，进随附条，不留在正文里
      setDraft((d) => d.slice(0, mention.start) + d.slice(mention.start + mention.q.length + 1));
      setAttFiles((f) => (f.includes(p.path) ? f : [...f, p.path]));
    }
    // 选中即收尾：在途的文件查询响应不该再把候选列表顶回来
    invalidateFileSearch();
    setMention(null);
    setMentionItems([]);
    taRef.current?.focus();
  };

  const addImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      if (data.startsWith("data:image/")) {
        setAttImages((imgs) => [...imgs, { name: file.name || `图片${++imgSeq.current}`, data }]);
      }
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    if (mention) {
      const pick = mentionItems[mentionIdx];
      if (pick) pickMention(pick);
      return;
    }
    // 上一发还没回结果：不再发第二发，草稿保持原样
    if (sending) return;
    const text = draft.trim();
    if (!text && !hasAtt) return;
    if (text === "/standby") {
      setDraft("");
      onStandby?.();
      return;
    }
    // 快照这一发携带的内容：等结果期间用户新写的字、新贴的图、新到的截图都不属于这一发
    const sentDraft = draft;
    const sentFiles = attFiles;
    const sentImages = attImages;
    const attachments = hasAtt ? { files: sentFiles, images: sentImages } : undefined;
    setSending(true);
    setSendErr(null);
    void Promise.resolve(onSend(text, busy ? mode : "queue", attachments))
      .then((err) => {
        if (err) {
          // 失败：草稿与随附一个字都不动，错误显示出来，改完可直接重发
          setSendErr(err);
          return;
        }
        // 成功：只清这一发带走的内容——发送期间新增的文字/附件必须留下
        setDraft((d) => (d === sentDraft ? "" : d.startsWith(sentDraft) ? d.slice(sentDraft.length) : d));
        setAttFiles((fs) => fs.filter((f) => !sentFiles.includes(f)));
        // 图片按对象引用剔除：发送途中新到的截图是另一个对象，不会被误清
        setAttImages((imgs) => imgs.filter((img) => !sentImages.includes(img)));
        setMention(null);
      })
      .catch((e) => setSendErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };

  const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);

  return (
    <div className="composer">
      {busy && (
        <div className="dispatch-strip">
          <span className="lbl">{t("composer.inProgress")}</span>
          <span className="dchip b">
            <span className="pip" /> {turn.phase === "review" ? t("composer.awaiting") : t("composer.running")}
          </span>
          {/* 状态行：串行工具轮期间必须看得见"在做什么 + 已用时"，否则像卡死 */}
          {turn.activity && (
            <span className="dchip">
              {turn.activity === "tool"
                ? t("composer.actTool", { name: turn.activityName ?? "" })
                : t("composer.actModel")}
              {elapsed > 0 ? ` · ${t("composer.elapsed", { s: elapsed })}` : ""}
            </span>
          )}
          {queue.length > 0 && (
            <>
              <span className="dchip">{t("composer.queued", { n: queue.length })}</span>
              {queue.map((q) => (
                <span key={q.id} className="dchip" title={q.text}>
                  {q.text.slice(0, 12)}
                  <button type="button" className="x" onClick={() => onQueue("remove", q.id)} title={t("composer.withdraw")}>
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="strip-link" onClick={() => onQueue("clear")}>
                {t("common.clear")}
              </button>
            </>
          )}
        </div>
      )}

      {/* 本轮随附条（M1-16）：发送前看得见她将带走的东西，每片可裁剪 */}
      {hasAtt && (
        <div className="attach-strip" role="list" aria-label="本轮随附">
          <span className="lbl">本轮随附</span>
          {attFiles.map((f) => (
            <span key={f} className="attach-chip" role="listitem" title={`将携带文件 ${f}`}>
              @{f}
              <button
                type="button"
                className="x"
                aria-label={`移除 ${f}`}
                onClick={() => setAttFiles((fs2) => fs2.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
          {attImages.map((img, i) => (
            <span key={`${img.name}-${i}`} className="attach-chip img" role="listitem" title={`将携带图片 ${img.name}`}>
              <img src={img.data} alt={img.name} />
              {img.name}
              <button
                type="button"
                className="x"
                aria-label={`移除 ${img.name}`}
                onClick={() => setAttImages((imgs) => imgs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 输入框上方的用量计：与顶栏同一套口径，点开看「缓存 + token 消耗」明细 */}
      <div className="composer-usage">
        <UsageMeter usage={usage} tokensUsed={tokensUsed} side="top" />
      </div>

      <div className="composer-row" style={{ position: "relative" }}>
        {mention && mentionItems.length > 0 && (
          <div className="mention-pop" role="listbox" aria-label="@ 补全">
            {mentionItems.map((it, i) => (
              <button
                type="button"
                key={it.kind === "member" ? `m:${it.name}` : `f:${it.path}`}
                role="option"
                aria-selected={i === mentionIdx}
                className={`mention-item${i === mentionIdx ? " on" : ""}${it.kind === "member" ? " who" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => pickMention(it)}
              >
                <span className="p">
                  {it.kind === "member" ? <Icon name="users" size="sm" /> : null}
                  @{it.kind === "member" ? it.name : it.path}
                </span>
                <span className="s">{it.kind === "member" ? (it.role ?? "成员") : fmtSize(it.size)}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-in"
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
            if (imgs.length > 0) {
              e.preventDefault();
              for (const it of imgs) {
                const f = it.getAsFile();
                if (f) addImage(f);
              }
            }
          }}
          onKeyDown={(e) => {
            if (mention && mentionItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // 退出 @ 同样让在途响应作废：候选收起后不该再被旧响应顶回来
                invalidateFileSearch();
                setMention(null);
                setMentionItems([]);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const pick = mentionItems[mentionIdx];
                if (pick) pickMention(pick);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            configured
              ? busy
                ? mode === "steer"
                  ? "插话：会打断当前方向…"
                  : "排队：这一轮结束后执行…"
                : variant === "review"
                  ? "告诉她怎么改，或直接回答她…"
                  : "交给风铃去做，或 @ 提及文件、粘贴图片…"
              : "先配置模型（我的风铃 → 模型）"
          }
        />
        {busy && (
          <div className="mode-toggle">
            <button type="button" className={`av-vbtn${mode === "queue" ? " on" : ""}`} onClick={() => setMode("queue")}>
              排队
            </button>
            <button type="button" className={`av-vbtn${mode === "steer" ? " on" : ""}`} onClick={() => setMode("steer")}>
              插话
            </button>
          </div>
        )}
        <Slot
          slot="composer.action"
          /* P9-1：崩了的插件要能一键停用，不该逼用户去设置页翻 */
          onDisable={(id) => toggleUi(id)}
          render={(p) =>
            p.sandbox ? (
              <SandboxAction plugin={p} onAction={(label) => setDraft((d) => `${d}!${label} `)} />
            ) : null
          }
        />
        {busy ? (
          <button type="button" className="send stop" onClick={onAbort} title={t("composer.stop")}>
            <i />
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={!canSend || sending} title={t("composer.send")}>
            <Icon name="send" />
          </button>
        )}
      </div>

      {/* 常驻快捷键提示删掉（2026-11-13）：Ctrl+/ 里有完整清单，天天压在输入框下面
          "Enter 发送 · Shift+Enter 换行 · @ 提及文件 · 粘贴图片 · Ctrl+K 跳转"是纯噪音。
          只有真有状态（生成中可排队/插话、截图失败）时才出这一行。 */}
      <div className={`composer-hint${busy || captureErr || sendErr || sending ? "" : " quiet"}`}>
        {busy && <span className="mono">生成中可排队或插话</span>}
        {sending && <span className="mono">发送中…</span>}
        {sendErr && <span className="capture-err">发送失败：{sendErr}（草稿与随附已保留，可重发）</span>}
        <button
          type="button"
          className="capture-trigger"
          title={t("capture.composerHint")}
          onClick={() => {
            setCaptureErr(null);
            void window.lynn
              .rpc("capture.start")
              .then((r) => {
                if (!r.ok) setCaptureErr(r.error ?? t("capture.failed"));
              })
              .catch((err: unknown) => setCaptureErr(`${t("capture.failed")}：${err instanceof Error ? err.message : String(err)}`));
          }}
        >
          {t("capture.trigger")}
        </button>
        {captureErr && <span className="capture-err">{captureErr}</span>}
      </div>
    </div>
  );
}

/**
 * @ 补全候选：成员（@ 留在正文，是群里的定向诉求）还是文件（@ 摘掉，进随附条）。
 * 两者混在一张列表里会让人误点——成员名和文件路径长得太像。
 */
type MentionItem =
  | { kind: "member"; name: string; role?: string }
  | { kind: "file"; path: string; size: number };
