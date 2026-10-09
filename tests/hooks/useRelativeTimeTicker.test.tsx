import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activity = vi.hoisted(() => ({ active: true }));

vi.mock("@/lib/windowActivity", () => ({
  useWindowActive: () => activity.active,
}));

import { useRelativeTimeTicker } from "@/hooks/useRelativeTimeTicker";

const TICK_MS = 30000;

describe("useRelativeTimeTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activity.active = true;
    vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks while the window is active and the caller opted in", () => {
    const { result } = renderHook(() => useRelativeTimeTicker(true, TICK_MS));
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(TICK_MS);
    });

    expect(result.current).toBeGreaterThan(initial);
  });

  it("does not tick while the window is not active", () => {
    activity.active = false;
    const { result } = renderHook(() => useRelativeTimeTicker(true, TICK_MS));
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(TICK_MS * 5);
    });

    expect(result.current).toBe(initial);
  });

  it("does not tick when the caller has nothing to track", () => {
    const { result } = renderHook(() => useRelativeTimeTicker(false, TICK_MS));
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(TICK_MS * 5);
    });

    expect(result.current).toBe(initial);
  });

  it("re-syncs immediately when the window becomes active again", () => {
    activity.active = false;
    const { result, rerender } = renderHook(() =>
      useRelativeTimeTicker(true, TICK_MS),
    );
    const stale = result.current;

    act(() => {
      vi.advanceTimersByTime(TICK_MS * 4);
    });
    expect(result.current).toBe(stale);

    activity.active = true;
    act(() => {
      vi.setSystemTime(new Date("2026-09-25T00:02:00Z"));
      rerender();
    });

    expect(result.current).toBeGreaterThan(stale);
  });
});