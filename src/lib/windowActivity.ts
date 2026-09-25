import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
 * Collapse a polling cadence to `false` unless the window is currently active.
 *
 * Every polling query funnels through here so "should this run right now?" stays
 * one decision in this module instead of an `&& windowActive ? N : false` ternary
 * repeated at each call site. Callers declare the cadence plus their own business
 * condition; the window-visibility half is never theirs to remember.
 *
 * A cadence of `0` (or negative) is treated as an opt-out, so callers that have
 * no interval to offer can pass `0` without branching.
 *
 * The one place this does not apply is a `refetchInterval` written in React
 * Query's function form, where the gate depends on the query's own `data` and is
 * therefore only knowable after the fetch — that shape keeps using
 * `isWindowActive()` directly.
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
