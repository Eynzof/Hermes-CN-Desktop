// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ModelOnboardingDialog } from "./model-onboarding-dialog";

vi.mock("@/hooks/use-config", () => ({
  useModelInfo: () => ({
    data: { model: "", provider: "", effective_context_length: 0 },
    isLoading: false,
    isError: false,
  }),
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("ModelOnboardingDialog accessibility", () => {
  it("binds the first-run dialog to a readable description without Radix warnings", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    render(
      <MemoryRouter>
        <ModelOnboardingDialog />
      </MemoryRouter>,
    );

    const dialog = screen.getByRole("dialog", { name: "开始使用 Hermes" });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "配置一个模型后即可开始任务",
    );

    await waitFor(() => {
      expect(warnings.filter((message) => (
        message.includes("Missing Description") || message.includes("aria-describedby")
      ))).toEqual([]);
    });
  });
});
