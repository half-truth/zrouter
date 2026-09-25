import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

describe("windowActivity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete document.documentElement.dataset.windowActive;
    delete document.documentElement.dataset.statusHeartbeat;
  });

  afterEach(() => {
    window.dispatchEvent(new Event("blur"));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("synchronizes an already-focused window during initialization", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const windowActivity = await import("@/lib/windowActivity");

    windowActivity.initializeWindowActivity();

    expect(windowActivity.isWindowActive()).toBe(true);
    expect(document.documentElement.dataset.windowActive).toBe("true");

    window.dispatchEvent(new Event("blur"));
    expect(windowActivity.isWindowActive()).toBe(false);
    expect(document.documentElement.dataset.windowActive).toBe("false");

    window.dispatchEvent(new Event("focus"));
    expect(windowActivity.isWindowActive()).toBe(true);
  });

  async function withActiveWindow() {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const mod = await import("@/lib/windowActivity");
    mod.initializeWindowActivity();
    return mod;
  }

  it("collapses the polling cadence while the window is not active", async () => {
    const { useGatedRefetchInterval } = await withActiveWindow();

    const { result } = renderHook(() => useGatedRefetchInterval(5_000));
    expect(result.current).toBe(5_000);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(5_000);
  });

  it("treats a non-positive cadence as an opt-out", async () => {
    const { useGatedRefetchInterval } = await withActiveWindow();

    const { result } = renderHook(() => useGatedRefetchInterval(0));
    expect(result.current).toBe(false);
  });

  it("collapses the cadence when the caller's own condition is off", async () => {
    const { useGatedRefetchInterval } = await withActiveWindow();

    const { result } = renderHook(() => useGatedRefetchInterval(5_000, false));
    expect(result.current).toBe(false);
  });
});
