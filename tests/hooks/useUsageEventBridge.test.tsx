import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitTauriEvent } from "../msw/tauriMocks";

const activity = vi.hoisted(() => ({
  active: true,
  listener: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/windowActivity", () => ({
  isWindowActive: () => activity.active,
  subscribeWindowActivity: (listener: () => void) => {
    activity.listener = listener;
    return () => {
      if (activity.listener === listener) {
        activity.listener = undefined;
      }
    };
  },
}));

import { useUsageEventBridge } from "@/hooks/useUsageEventBridge";
import { usageKeys } from "@/lib/query/usage";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useUsageEventBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activity.active = true;
    activity.listener = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces active-window events into one refresh", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useUsageEventBridge(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {});

    act(() => {
      emitTauriEvent("usage-log-recorded", null);
      emitTauriEvent("usage-log-recorded", null);
      emitTauriEvent("usage-log-recorded", null);
    });
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: usageKeys.all });
  });

  it("defers hidden-window events and refreshes once after focus returns", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useUsageEventBridge(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {});

    activity.active = false;
    act(() => {
      emitTauriEvent("usage-log-recorded", null);
      emitTauriEvent("usage-log-recorded", null);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(invalidate).not.toHaveBeenCalled();

    activity.active = true;
    act(() => {
      activity.listener?.();
      vi.advanceTimersByTime(1_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: usageKeys.all });
  });
});