// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelSwitcher } from "./model-switcher";

vi.mock("@/hooks/use-model-switch", () => ({
  useSessionModelSwitch: () => ({
    switchTo: vi.fn(async (model: string, scope: string) => ({
      model,
      provider: "fake-provider",
      scope,
    })),
    isPending: false,
  }),
}));

afterEach(() => cleanup());

describe("ModelSwitcher", () => {
  it("opens, selects a model + scope and confirms the switch", async () => {
    const onSwitch = vi.fn();
    render(
      <ModelSwitcher
        sessionId="s1"
        currentSelection={{ model: "model-a", provider: "p1" }}
        models={["model-a", "model-b"]}
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /model-a/ }));
    fireEvent.click(screen.getByRole("option", { name: /model-b/ }));
    fireEvent.click(screen.getByRole("button", { name: /设为默认/ }));
    fireEvent.click(screen.getByRole("button", { name: /切换/ }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith({ model: "model-b", provider: "fake-provider" }));
  });

  it("does not switch when the confirm button is disabled without a model", () => {
    const onSwitch = vi.fn();
    render(
      <ModelSwitcher
        sessionId="s1"
        currentSelection={{ model: "", provider: "" }}
        models={[]}
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /切换模型/ }));
    expect(onSwitch).not.toHaveBeenCalled();
  });
});
