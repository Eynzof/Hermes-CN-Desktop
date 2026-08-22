// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextUsagePanel } from "./context-usage-panel";

describe("ContextUsagePanel", () => {
  it("renders empty state", () => {
    render(<ContextUsagePanel usage={null} />);
    expect(screen.getByText("No context usage data available.")).toBeDefined();
  });

  it("renders category rows and percentage", () => {
    const usage = {
      model: "gpt-4o",
      used: 2000,
      max: 4000,
      percent: 50,
      estimated: false,
      compressions: 0,
      categories: [
        { id: "system_prompt", label: "System Prompt", tokens: 100, color: "#7c3aed" },
        { id: "conversation", label: "Conversation", tokens: 1900, color: "#4b5563" },
      ],
    };
    render(<ContextUsagePanel usage={usage} />);
    expect(screen.getByText("Context Usage")).toBeDefined();
    expect(screen.getByText("gpt-4o")).toBeDefined();
    expect(screen.getByText("System Prompt")).toBeDefined();
    expect(screen.getByText("Conversation")).toBeDefined();
    expect(screen.getByText("50.0%")).toBeDefined();
  });
});
