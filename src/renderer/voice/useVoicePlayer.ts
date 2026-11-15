import { useEffect } from "react";

/**
 * 语音播放（渲染层）：合成好的 MP3 由 lynn:voice 送来，这里只管排队与静音。
 *
 * 纪律：串行播放、高优先级打断、stop 立刻清空；播放被浏览器自动播放策略拦下时
 * 不假装播过，只跳过这一条（下次有用户交互后自然恢复）。
 */
const QUEUE_CAP = 10;
const PRIORITY_RANK = { low: 0, normal: 1, high: 2 } as const;

type VoicePriority = keyof typeof PRIORITY_RANK;
interface QueueEntry {
  audio: HTMLAudioElement;
  priority: VoicePriority;
  generation: number;
}

export function useVoicePlayer(): void {
  useEffect(() => {
    let current: QueueEntry | null = null;
    let queue: QueueEntry[] = [];
    let disposed = false;
    // stop / 高优先级打断都会换一代，旧音频的异步回调不能再碰新一代的播放状态。
    let generation = 0;

    const release = (entry: QueueEntry) => {
      entry.audio.onended = null;
      entry.audio.onerror = null;
      entry.audio.pause();
      entry.audio.src = "";
    };

    const stopAll = () => {
      generation += 1;
      if (current) {
        release(current);
        current = null;
      }
      for (const entry of queue) release(entry);
      queue = [];
    };

    const playNext = () => {
      if (disposed || current) return;
      const next = queue.shift();
      if (!next) return;
      if (next.generation !== generation) {
        release(next);
        playNext();
        return;
      }
      current = next;
      const finish = () => {
        if (disposed || next.generation !== generation || current !== next) return;
        release(next);
        current = null;
        playNext();
      };
      next.audio.onended = finish;
      next.audio.onerror = finish;
      void next.audio.play().catch(() => {
        if (disposed || next.generation !== generation || current !== next) return;
        console.warn("[voice] 播放被阻止（自动播放策略或音频设备不可用）");
        finish();
      });
    };

    const makeRoom = (incoming: QueueEntry): boolean => {
      if (queue.length < QUEUE_CAP) return true;
      const lowest = Math.min(...queue.map((entry) => PRIORITY_RANK[entry.priority]));
      // 队列里全是更高优先级时，新到的低优先级不挤掉已有内容。
      if (PRIORITY_RANK[incoming.priority] < lowest) return false;
      const index = queue.findIndex((entry) => PRIORITY_RANK[entry.priority] === lowest);
      const [evicted] = queue.splice(index, 1);
      release(evicted);
      return true;
    };

    const off = window.lynn.onVoice((ev) => {
      if (disposed) return;
      if (ev.type === "stop") {
        stopAll();
        return;
      }
      if (ev.priority === "high") stopAll();
      const entry: QueueEntry = { audio: new Audio(ev.audio), priority: ev.priority, generation };
      if (!makeRoom(entry)) {
        release(entry);
        return;
      }
      queue.push(entry);
      playNext();
    });

    return () => {
      disposed = true;
      off();
      stopAll();
    };
  }, []);
}
