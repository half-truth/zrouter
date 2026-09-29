import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";

const { getToolVersionsMock } = vi.hoisted(() => ({
  getToolVersionsMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("3.20.4"),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    getToolVersions: (...args: unknown[]) => getToolVersionsMock(...args),
    openExternal: vi.fn().mockResolvedValue(undefined),
    checkUpdates: vi.fn().mockResolvedValue(undefined),
    installUpdateAndRestart: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    updateInfo: null,
    checkUpdate: vi.fn().mockResolvedValue(false),
    resetDismiss: vi.fn(),
    isChecking: false,
  }),
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => false,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const toolNames = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "mcode",
];

function versionResult(name: string) {
  return {
    name,
    version: "1.0.0",
    latest_version: "1.0.0",
    error: null,
    installed_but_broken: false,
    env_type: "macos" as const,
    wsl_distro: null,
  };
}

describe("AboutSection tool version detection", () => {
  it("detects versions only after an explicit click and reuses the session cache", async () => {
    const user = userEvent.setup();
    getToolVersionsMock.mockResolvedValue(toolNames.map(versionResult));

    const first = render(<AboutSection isPortable={false} />);

    expect(getToolVersionsMock).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("settings.toolVersionsNotDetected").length,
    ).toBeGreaterThan(0);
    expect(
      first.container.querySelector(".animate-\\[spin_4s_linear_infinite\\]"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "settings.toolDetectVersions" }),
    );

    await waitFor(() => expect(getToolVersionsMock).toHaveBeenCalledTimes(1));
    expect(getToolVersionsMock).toHaveBeenCalledWith(toolNames, {});
    expect((await screen.findAllByText("1.0.0")).length).toBeGreaterThan(0);

    first.unmount();
    render(<AboutSection isPortable={false} />);

    await waitFor(() =>
      expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0),
    );
    expect(getToolVersionsMock).toHaveBeenCalledTimes(1);
  });
});
