import { useEffect } from "react";

/**
 * 语音播放（渲染层）：合成好的 MP3 由 lynn:voice 送来，这里只管排队与静音。
 *
 * 纪律：串行播放、高优先级打断、stop 立刻清空；播放被浏览器自动播放策略拦下时
 * 不假装播过，只跳过这一条（下次有用户交互后自然恢复）。
 */
export function useVoicePlayer(): void {
  useEffect(() => {
    let current: HTMLAudioElement | null = null;
    let queue: HTMLAudioElement[] = [];
    let disposed = false;

    const stopAll = () => {
      if (current) {
        current.pause();
        current.src = "";
        current = null;
      }
      for (const a of queue) {
        a.pause();
        a.src = "";
      }
      queue = [];
    };

    const playNext = () => {
      if (disposed || current) return;
      const next = queue.shift();
      if (!next) return;
      current = next;
      next.onended = () => {
        current = null;
        playNext();
      };
      next.onerror = () => {
        current = null;
        playNext();
      };
      void next.play().catch(() => {
        console.warn("[voice] 播放被阻止（自动播放策略或音频设备不可用）");
        current = null;
        playNext();
      });
    };

    const off = window.lynn.onVoice((ev) => {
      if (disposed) return;
      if (ev.type === "stop") {
        stopAll();
        return;
      }
      const audio = new Audio(ev.audio);
      if (ev.priority === "high") stopAll();
      queue.push(audio);
      playNext();
    });

    return () => {
      disposed = true;
      off();
      stopAll();
    };
  }, []);
}
