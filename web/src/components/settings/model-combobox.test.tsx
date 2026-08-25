// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ModelCombobox } from "./model-combobox";
import { filterOptions } from "./model-combobox";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(cleanup);

describe("filterOptions", () => {
  const all = ["deepseek-v4-flash", "deepseek-v4-pro", "qwen3-coder-plus", "glm-5.1"];

  it("returns all options for an empty query", () => {
    expect(filterOptions(all, "")).toEqual(all);
  });

  it("filters case-insensitively by substring", () => {
    expect(filterOptions(all, "deepseek")).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(filterOptions(all, "DEEPSEEK")).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterOptions(all, "claude")).toEqual([]);
  });
});

describe("ModelCombobox accessibility", () => {
  it("keeps its list relationship valid and reports the actual expanded state", async () => {
    render(
      <ModelCombobox
        label="默认模型"
        value="hermes-model"
        onChange={() => undefined}
        options={["hermes-model"]}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "默认模型" });
    const listId = combobox.getAttribute("aria-controls");

    expect(listId).toBeTruthy();
    expect(document.getElementById(listId!)).not.toBeNull();
    await waitFor(() => expect(combobox.getAttribute("aria-expanded")).toBe("false"));

    fireEvent.click(combobox);
    await waitFor(() => expect(combobox.getAttribute("aria-expanded")).toBe("true"));
    expect(document.getElementById(listId!)).not.toBeNull();

    fireEvent.keyDown(combobox, { key: "Escape" });
    await waitFor(() => expect(combobox.getAttribute("aria-expanded")).toBe("false"));
    expect(document.getElementById(listId!)).not.toBeNull();
  });
});
