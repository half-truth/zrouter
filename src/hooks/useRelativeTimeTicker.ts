import { useEffect, useState } from "react";
import { useWindowActive } from "@/lib/windowActivity";

const DEFAULT_TICK_INTERVAL_MS = 30000;

/**
 * Ticks a timestamp used to render "3 minutes ago" style labels.
 *
 * The caller only declares that there is a timestamp worth tracking; when the
 * ticker actually runs is this hook's decision. It idles while the window is
 * not active, and re-syncs immediately on refocus instead of letting the label
 * sit stale for up to one interval.
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
