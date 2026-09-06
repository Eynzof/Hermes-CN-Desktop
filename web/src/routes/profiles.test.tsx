// @vitest-environment jsdom

import type { ProfileSummary } from "@hermes/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  profile: {
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
  },
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfile: () => ({
    data: { active: "default", current: "default" },
    error: null,
    isError: false,
    isLoading: false,
  }),
  useProfiles: () => ({
    data: [mocks.profile],
    error: null,
    isError: false,
    isLoading: false,
  }),
  useProfileSetupCommand: () => ({ mutateAsync: vi.fn() }),
  useSetActiveProfile: () => ({
    isPending: false,
    mutate: mocks.mutate,
    variables: undefined,
  }),
}));

vi.mock("@/lib/runtime", () => ({
  runtime: {
    isAttached: () => false,
    platform: "win32",
  },
}));

vi.mock("@/components/profiles", () => ({
  ActiveCurrentBanner: () => null,
  ProfileCard: ({ profile: item, onSetActive }: {
    profile: ProfileSummary;
    onSetActive: () => void;
  }) => <button onClick={onSetActive}>切换到 {item.name}</button>,
  ProfileCreateDialog: () => null,
  ProfileDeleteDialog: () => null,
  ProfileDescriptionDialog: () => null,
  ProfileModelDialog: () => null,
  ProfileRenameDialog: () => null,
  ProfileSoulDialog: () => null,
}));

import { ProfilesRoute } from "./profiles";

beforeEach(() => {
  mocks.mutate.mockReset();
});

afterEach(cleanup);

describe("ProfilesRoute switching feedback", () => {
  it("surfaces a native switch rejection to the user", () => {
    mocks.mutate.mockImplementation((_name, options) => {
      options.onError(new Error("native switch rejected"));
    });
    render(
      <MemoryRouter>
        <ProfilesRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到 reviewer" }));

    expect(screen.getByText("native switch rejected")).toBeTruthy();
  });
});
