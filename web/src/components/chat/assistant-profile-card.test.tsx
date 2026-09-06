// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Provider } from "jotai";
import { stubRadixGlobals } from "@/test-utils/radix";
import { AssistantProfileCard } from "./assistant-profile-card";

stubRadixGlobals();
beforeEach(() => cleanup());

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

describe("AssistantProfileCard", () => {
  it("navigates via 发消息 / 编辑人格 / 更换头像", () => {
    render(
      <Provider>
        <MemoryRouter initialEntries={["/chat"]}>
          <AssistantProfileCard trigger={<button type="button">头像</button>} model="fake-model" />
          <LocationProbe />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "头像" }));
    fireEvent.click(screen.getByRole("button", { name: /发消息/ }));
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /编辑人格/ }));
    expect(screen.getByTestId("path").textContent).toBe("/soul");
    fireEvent.click(screen.getByRole("button", { name: /更换头像/ }));
    expect(screen.getByTestId("path").textContent).toBe("/common");
  });

  it("opens and closes the avatar zoom overlay", () => {
    render(
      <Provider>
        <MemoryRouter>
          <AssistantProfileCard trigger={<button type="button">头像</button>} />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "头像" }));
    fireEvent.click(screen.getByRole("button", { name: "放大查看头像" }));
    // overlay image alt text = `${displayName} 头像大图`
    expect(screen.getByAltText(/头像大图/)).toBeTruthy();
    fireEvent.click(screen.getByRole("presentation"));
    expect(screen.queryByAltText(/头像大图/)).toBeNull();
  });
});
