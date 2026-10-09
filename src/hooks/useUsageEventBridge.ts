import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { usageKeys } from "@/lib/query/usage";
import { isWindowActive, subscribeWindowActivity } from "@/lib/windowActivity";

const REFRESH_DEBOUNCE_MS = 1000;

/**
 * 监听后端 `usage-log-recorded` 事件并合并刷新 UsageDashboard 查询。
 * 后端已按 200ms 窗口合并写入事件；前端再按 1 秒窗口合并 invalidation，
 * 窗口失焦时只标记 dirty，恢复焦点后刷新一次。
 *
 * 该 hook 只挂在 UsageDashboard 上，离开页面会自动取消监听。
 */
export function useUsageEventBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    let dirty = false;
    let refreshTimer: number | undefined;

    const flush = () => {
      refreshTimer = undefined;
      if (!isWindowActive()) {
        dirty = true;
        return;
      }
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    };

    const scheduleRefresh = () => {
      if (!isWindowActive()) {
        dirty = true;
        return;
      }

      if (refreshTimer === undefined) {
        refreshTimer = window.setTimeout(flush, REFRESH_DEBOUNCE_MS);
      }
    };

    const unsubscribeActivity = subscribeWindowActivity(() => {
      if (isWindowActive() && dirty) {
        dirty = false;
        scheduleRefresh();
      }
    });

    (async () => {
      const off = await listen("usage-log-recorded", scheduleRefresh);

      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    })();

    return () => {
      disposed = true;
      unsubscribeActivity();
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      unlisten?.();
    };
  }, [queryClient]);
}
