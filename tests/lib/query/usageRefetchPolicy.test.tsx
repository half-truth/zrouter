import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activity = vi.hoisted(() => ({ active: true }));
const useQuerySpy = vi.hoisted(() =>
  vi.fn((_options: Record<string, unknown>) => ({ data: undefined })),
);

vi.mock("@/lib/windowActivity", () => ({
  useWindowActive: () => activity.active,
  // Mirrors the real gate so this file can still assert the *composed* policy:
  // what cadence usage.ts resolves and hands over. The gate's own behaviour is
  // covered against the real module in tests/lib/windowActivity.test.ts.
  useGatedRefetchInterval: (intervalMs: number, enabled = true) =>
    enabled && activity.active && intervalMs > 0 ? intervalMs : false,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: useQuerySpy };
});

import { useModelStats, useUsageSummaryByApp } from "@/lib/query/usage";
import type { UsageRangeSelection } from "@/types/usage";

const range: UsageRangeSelection = { preset: "7d" };

function lastQueryOptions() {
  const options = useQuerySpy.mock.calls.at(-1)?.[0];
  return options as unknown as {
    refetchInterval: number | false;
    refetchIntervalInBackground: boolean;
  };
}

describe("usage query refetch policy", () => {
  beforeEach(() => {
    activity.active = true;
    useQuerySpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls on the requested cadence while the window is active", () => {
    renderHook(() => useModelStats(range, undefined, { refetchInterval: 5000 }));

    expect(lastQueryOptions().refetchInterval).toBe(5000);
  });

  it("stops polling when the window is not active", () => {
    activity.active = false;
    renderHook(() => useModelStats(range, undefined, { refetchInterval: 5000 }));

    expect(lastQueryOptions().refetchInterval).toBe(false);
  });

  it("keeps the default cadence out of the background too", () => {
    activity.active = false;
    renderHook(() => useUsageSummaryByApp(range));

    const options = lastQueryOptions();
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("honours an explicit opt-out regardless of window activity", () => {
    renderHook(() => useModelStats(range, undefined, { refetchInterval: false }));

    expect(lastQueryOptions().refetchInterval).toBe(false);
  });

  it("treats a zero interval as opt-out", () => {
    renderHook(() => useModelStats(range, undefined, { refetchInterval: 0 }));

    expect(lastQueryOptions().refetchInterval).toBe(false);
  });

  it("gates every usage query that declares a cadence", () => {
    activity.active = false;
    // 每个导出 hook 都必须走门控工厂；漏掉一个就会在托盘里继续按默认 30s 轮询。
    renderHook(() => useUsageSummaryByApp(range));
    expect(lastQueryOptions().refetchInterval).toBe(false);

    renderHook(() => useModelStats(range));
    expect(lastQueryOptions().refetchInterval).toBe(false);
  });
});