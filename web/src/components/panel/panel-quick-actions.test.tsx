// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, useAtomValue } from "jotai";
import { QuickStart, RECIPES_PANEL } from "./quick-start";
import { composerPrefillAtom } from "@/stores/panel";

afterEach(() => cleanup());

describe("QuickStart", () => {
  it("fills the composer prefill when a recipe card is clicked", () => {
    function Probe() {
      const prefill = useAtomValue(composerPrefillAtom);
      return <output data-testid="prefill">{prefill?.text ?? ""}</output>;
    }
    render(
      <Provider>
        <QuickStart recipes={[RECIPES_PANEL[0]]} />
        <Probe />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /代码评审/ }));
    expect(screen.getByTestId("prefill").textContent).toBe(RECIPES_PANEL[0].prompt);
  });
});
