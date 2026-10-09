import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 30s：心跳只是「窗口还活着」的兜底信号，3s 一次在页面完全静止时仍是每秒
// 一次的根 DOM 写入 + 300ms 透明度动画。
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_DIM_MS = 300;

let initialized = false;
let active = false;
const activityListeners = new Set<() => void>();
let heartbeatInterval: number | undefined;
let heartbeatReset: number | undefined;

export function isWindowActive() {
  return active;
}

export function subscribeWindowActivity(listener: () => void) {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function useWindowActive() {
  return useSyncExternalStore(
    subscribeWindowActivity,
    isWindowActive,
    () => false,
  );
}

/**
 * 把轮询节奏折叠成 `false`，除非窗口当前处于活跃状态。
 *
 * 所有轮询查询都从这里走，好让「现在该不该跑」只在这一个模块里决定一次，
 * 而不是每个调用点各写一遍 `&& windowActive ? N : false`。调用方只声明节奏
 * 加上自己的业务条件，窗口可见性那一半不该由它们记得。
 *
 * 节奏为 `0`（或负数）视为退出开关，于是没有间隔可给的调用方直接传 `0`
 * 即可，不必自己分支。
 *
 * 唯一的例外是 React Query 的函数式 `refetchInterval`：那里的门控依赖该查询
 * 自己的 `data`，只有取回之后才知道，因此那种写法继续直接用
 * `isWindowActive()`。
 */
export function useGatedRefetchInterval(
  intervalMs: number,
  enabled = true,
): number | false {
  const windowActive = useWindowActive();
  return enabled && windowActive && intervalMs > 0 ? intervalMs : false;
}

function notifyWindowActivity() {
  for (const listener of activityListeners) {
    listener();
  }
}

function stopHeartbeat() {
  if (heartbeatInterval !== undefined) {
    window.clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }
  if (heartbeatReset !== undefined) {
    window.clearTimeout(heartbeatReset);
    heartbeatReset = undefined;
  }
  delete document.documentElement.dataset.statusHeartbeat;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = window.setInterval(() => {
    document.documentElement.dataset.statusHeartbeat = "true";
    heartbeatReset = window.setTimeout(() => {
      delete document.documentElement.dataset.statusHeartbeat;
      heartbeatReset = undefined;
    }, HEARTBEAT_DIM_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function setWindowActive(nextActive: boolean) {
  // Tauri 的 focus 事件与浏览器 fallback 会重复报告同一状态；不去重的话
  // 每次重复都会重启心跳定时器并唤醒全部订阅者。
  const hasDomState =
    document.documentElement.dataset.windowActive !== undefined;
  if (hasDomState && active === nextActive) return;
  active = nextActive;
  document.documentElement.dataset.windowActive = String(active);
  notifyWindowActivity();

  if (active) {
    startHeartbeat();
  } else {
    stopHeartbeat();
  }
}

export function initializeWindowActivity() {
  if (initialized) return;
  initialized = true;

  setWindowActive(document.hasFocus());

  // Browser focus events are a fallback for non-Tauri renderer tests and dev mode.
  window.addEventListener("focus", () => setWindowActive(true));
  window.addEventListener("blur", () => setWindowActive(false));

  if (isTauri()) {
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => setWindowActive(payload))
      .catch((error) => {
        console.error("Failed to observe window focus changes", error);
      });
  }
}
