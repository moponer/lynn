/**
 * 等一轮对话结束（2026-11-18 P13-4）。
 *
 * ## 为什么需要它
 *
 * 外部 IM 网关要的是**请求-响应**语义：
 *
 * ```
 * POST /api/session.prompt { text }
 * → { ok: true }   // 等这一轮真的回答完了才返回
 * ```
 *
 * 但 Lynn 的 `submitTurn` 是 **void + 流式**：它启动一轮就返回，
 * 回答通过 `delta` 事件陆续推给界面。所以需要一个"等它结束"的桥。
 *
 * ## 怎么判断"结束了"
 *
 * 监听 `turn` 事件：
 *  - `busy === true` → 这一轮在跑
 *  - `busy === false` 且之前 busy 过 → 这一轮结束了
 *
 * **必须先看到 busy 再看到 idle**，不能一上来就等 idle——
 * `submitTurn` 是同步返回的，它之后的下一个事件才可能是 `busy=true`。
 * 如果直接等 idle，会在 `busy` 还没置起来时就误判"已完成"。
 *
 * ## 为什么不看 `phase`
 *
 * `phase` 有 idle / working / review / awaiting_plan / done 等多个值，
 * 且不同轮次走的分支不同（比如派单轮会停在 review 等用户拍板）。
 * `busy` 是唯一稳定表示"内核还在干活"的字段。
 */

/** 内核事件里与本模块相关的形状（窄接口，不依赖完整 KernelEvent） */
export interface TurnEventLike {
  type: string;
  turn?: { busy?: boolean; phase?: string };
}

export interface WaitOptions {
  /** 总超时（默认 10 分钟：派单轮可能很久） */
  timeoutMs?: number;
  /** 订阅事件，返回取消订阅函数 */
  subscribe(cb: (ev: TurnEventLike) => void): () => void;
  /** 启动这一轮（同步返回，之后才会有 busy 事件） */
  start(): void;
  /** 超时时的清理（比如中断这一轮） */
  onTimeout?(): void;
}

/**
 * 启动一轮并等它结束。
 *
 * 返回的 Promise：
 *  - resolve：这一轮正常结束
 *  - reject：超时，或订阅期间出现致命错误
 */
export function runTurnAndWait(opts: WaitOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<void>((resolve, reject) => {
    let sawBusy = false;
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        /* 取消失败不影响结果 */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        /**
         * 超时不代表这一轮失败了——它可能还在跑。
         * 错误信息要说清这一点，否则调用方会以为"请求失败"而重发，
         * 结果是同一件事被做两遍。
         */
        try {
          opts.onTimeout?.();
        } catch {
          /* 清理失败不改变结论 */
        }
        reject(new Error(`等这一轮超时（${Math.round(timeoutMs / 60000)} 分钟）：它可能还在跑`));
      });
    }, timeoutMs);

    unsubscribe = opts.subscribe((ev) => {
      if (ev.type !== "turn" || !ev.turn) return;
      const busy = ev.turn.busy === true;
      if (busy) {
        sawBusy = true;
        return;
      }
      /**
       * 只有"见过 busy 之后又 idle"才算结束。
       * 这条判断是这个模块唯一的难点：`submitTurn` 同步返回，
       * 它之前的事件里 `busy` 还是 false——直接等 false 会立刻 resolve。
       */
      if (sawBusy) finish(() => resolve());
    });

    try {
      opts.start();
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}