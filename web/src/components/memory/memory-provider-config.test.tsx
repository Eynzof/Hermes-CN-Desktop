// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryProviderConfigResponse } from "@hermes/protocol";
import { MemoryProviderConfig } from "./memory-provider-config";

describe("MemoryProviderConfig", () => {
  it("renders Core integer and number fields with their numeric constraints", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const config = {
      name: "openviking",
      label: "OpenViking",
      fields: [
        {
          key: "recall_limit",
          label: "Recall Limit",
          kind: "integer",
          value: "12",
          minimum: 1,
          maximum: 100,
          step: undefined,
          description: "",
          placeholder: "",
          required: false,
          is_set: true,
          options: [],
          url: "",
        },
        {
          key: "recall_score_threshold",
          label: "Recall Score Threshold",
          kind: "number",
          value: "0.4",
          minimum: 0,
          maximum: 1,
          step: 0.01,
          description: "",
          placeholder: "",
          required: false,
          is_set: true,
          options: [],
          url: "",
        },
      ],
      setup: { dependencies_installed: true },
    } as unknown as MemoryProviderConfigResponse;

    render(
      <MemoryProviderConfig
        provider="openviking"
        config={config}
        loading={false}
        saving={false}
        setupPending={false}
        onSave={onSave}
        onSetup={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const integer = screen.getByLabelText(/recall limit/i) as HTMLInputElement;
    expect(integer.type).toBe("number");
    expect(integer.min).toBe("1");
    expect(integer.max).toBe("100");
    expect(integer.step).toBe("1");

    const decimal = screen.getByLabelText(/recall score threshold/i) as HTMLInputElement;
    expect(decimal.type).toBe("number");
    expect(decimal.min).toBe("0");
    expect(decimal.max).toBe("1");
    expect(decimal.step).toBe("0.01");

    fireEvent.change(integer, { target: { value: "13" } });
    fireEvent.change(decimal, { target: { value: "0.42" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并检测" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        recall_limit: "13",
        recall_score_threshold: "0.42",
      });
    });
  });
});
