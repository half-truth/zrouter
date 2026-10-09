import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToolVersions: vi.fn(),
  probeToolInstallations: vi.fn(),
  listToolInstallations: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ settingsApi: mocks }));
vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getClaudeDesktopStatus: async () => ({ supported: true, configured: true }),
  },
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { visibleApps: undefined },
    updateSettings: vi.fn(),
    autoSaveSettings: vi.fn(async () => null),
  }),
}));
vi.mock("sonner", () => ({ toast: mocks }));

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function card(name: string) {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest("[data-tool-row]"))
    .find((el): el is HTMLElement => el !== null);
  if (!row) throw new Error(`no tool row named ${name}`);
  return within(row);
}

const detectButton = (name: string) =>
  card(name).getByRole("button", {
    name: /settings\.toolDetectVersions|settings\.toolDetectAgain/,
  });

function versionFor(name: string, version: string | null) {
  return {
    name,
    version,
    latest_version: version,
    error: null,
    installed_but_broken: false,
    env_type: "macos",
    wsl_distro: null,
  };
}

describe("AppsPage tool version detection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getToolVersions.mockImplementation(async (tools: string[]) =>
      tools.map((tool) => versionFor(tool, "1.0.0")),
    );
    mocks.probeToolInstallations.mockResolvedValue([]);
    mocks.listToolInstallations.mockResolvedValue([]);
  });

  async function renderAppsPage() {
    const { AppsPage } = await import("@/components/apps/AppsPage");
    return render(<AppsPage />, { wrapper: Wrapper });
  }

  it("does not probe tool versions when the page opens", async () => {
    await renderAppsPage();

    // 安装分布（纯路径解析）照常查，版本探测要等用户点。
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());
    expect(mocks.getToolVersions).not.toHaveBeenCalled();
  });

  it("offers no bulk detect: every row carries its own", async () => {
    await renderAppsPage();
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());

    // 批量「检查更新」是发热源，必须不存在；检测入口只在行内。
    expect(screen.queryByText("appsPage.checkUpdates")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "appsPage.checkUpdates" }),
    ).not.toBeInTheDocument();

    for (const name of ["Claude Code", "Codex", "Gemini CLI"]) {
      expect(detectButton(name)).toBeInTheDocument();
    }
  });

  it("probes exactly one tool per click, never the whole list", async () => {
    await renderAppsPage();
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(detectButton("Claude Code"));
    });

    // 关键约束：一次点击只提交一个工具名。九个一起查会让机器明显发热。
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(1));
    expect(mocks.getToolVersions).toHaveBeenCalledWith(["claude"], expect.anything());

    // 第二次点击仍然只查一个，且是另一个工具。
    await act(async () => {
      fireEvent.click(detectButton("Codex"));
    });
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(2));
    expect(mocks.getToolVersions).toHaveBeenLastCalledWith(
      ["codex"],
      expect.anything(),
    );
  });

  it("keeps other rows unprobed after one row is detected", async () => {
    await renderAppsPage();
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(detectButton("Claude Code"));
    });
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(1));

    expect(card("Claude Code").getByText("1.0.0")).toBeInTheDocument();
    // 没点的行仍显示自己的「检测」入口，且不能因为隔壁查过就连带显示成已安装。
    expect(card("Codex").queryByText("common.notInstalled")).not.toBeInTheDocument();
    expect(detectButton("Codex")).toBeInTheDocument();
  });

  it("lets the user re-detect a single row that already has a result", async () => {
    await renderAppsPage();
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(detectButton("Claude Code"));
    });
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(1));
    expect(
      card("Claude Code").getByRole("button", {
        name: "settings.toolDetectAgain",
      }),
    ).toBeInTheDocument();

    mocks.getToolVersions.mockResolvedValue([versionFor("claude", "2.0.0")]);
    await act(async () => {
      fireEvent.click(
        card("Claude Code").getByRole("button", {
          name: "settings.toolDetectAgain",
        }),
      );
    });

    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(2));
    expect(mocks.getToolVersions).toHaveBeenLastCalledWith(
      ["claude"],
      expect.anything(),
    );
    expect(card("Claude Code").getByText("2.0.0")).toBeInTheDocument();
  });

  it("does not re-probe when returning to the page with a fresh cache", async () => {
    const first = await renderAppsPage();
    await waitFor(() => expect(mocks.listToolInstallations).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(detectButton("Claude Code"));
    });
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(1));
    first.unmount();

    await renderAppsPage();
    await waitFor(() =>
      expect(screen.getByText("appsPage.refreshInstalls")).toBeInTheDocument(),
    );

    // 重挂不探测：既没有自动探测，也没有 TTL 过期驱动的后台重查。
    expect(mocks.getToolVersions).toHaveBeenCalledTimes(1);
  });
});