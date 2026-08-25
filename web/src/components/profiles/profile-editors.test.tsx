// @vitest-environment jsdom

import type { ProfileSummary } from "@hermes/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  soul: {
    data: { content: "cached SOUL", exists: true },
    error: null,
    isError: false,
    isLoading: false,
  },
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useDescribeProfileAuto: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
  }),
  useProfileSoul: () => mocks.soul,
  useSetProfileModel: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateProfileDescription: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
  }),
  useUpdateProfileSoul: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: mocks.mutate,
  }),
}));

import { ProfileSoulDialog } from "./profile-editors";

const profile: ProfileSummary = {
  name: "reviewer",
  path: "/profiles/reviewer",
  is_default: false,
  model: null,
  provider: null,
  has_env: false,
  skill_count: 0,
  gateway_running: false,
  description: "",
  description_auto: false,
  distribution_name: null,
  distribution_version: null,
  distribution_source: null,
  has_alias: false,
};

function renderDialog() {
  return render(<ProfileSoulDialog profile={profile} onClose={vi.fn()} />);
}

beforeEach(() => {
  mocks.soul.data = { content: "cached SOUL", exists: true };
  mocks.mutate.mockReset();
});

afterEach(cleanup);

describe("ProfileSoulDialog server reconciliation", () => {
  it("adopts a fresh refetch response while the editor is pristine", async () => {
    const view = renderDialog();
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textbox.value).toBe("cached SOUL"));

    mocks.soul.data = { content: "fresh SOUL", exists: true };
    view.rerender(<ProfileSoulDialog profile={profile} onClose={vi.fn()} />);

    await waitFor(() => expect(textbox.value).toBe("fresh SOUL"));
  });

  it("preserves a local draft when a fresh refetch response arrives", async () => {
    const view = renderDialog();
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textbox.value).toBe("cached SOUL"));
    fireEvent.change(textbox, { target: { value: "local draft" } });

    mocks.soul.data = { content: "fresh SOUL", exists: true };
    view.rerender(<ProfileSoulDialog profile={profile} onClose={vi.fn()} />);

    await waitFor(() => expect(textbox.value).toBe("local draft"));
  });
});
