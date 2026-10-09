import { useEffect, useState } from "react";
import { useWindowActive } from "@/lib/windowActivity";

const DEFAULT_TICK_INTERVAL_MS = 30000;

/**
 * 为「3 分钟前」这类标签驱动一个时钟。
 *
 * 调用方只声明「有一个值得跟踪的时间戳」；什么时候真的走表由本 hook 决定。
 * 窗口不活跃时停表，重新聚焦时立刻重新对齐，而不是让标签最多陈旧一个周期。
 */
export function useRelativeTimeTicker(
  enabled: boolean,
  intervalMs: number = DEFAULT_TICK_INTERVAL_MS,
): number {
  const windowActive = useWindowActive();
  const running = enabled && windowActive;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [running, intervalMs]);

  return now;
}
