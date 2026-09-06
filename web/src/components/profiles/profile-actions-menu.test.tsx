// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileSummary } from "@hermes/protocol";
import { ProfileActionsMenu } from "./profile-actions-menu";

// The Popover opens on pointer events that jsdom can't fully synthesize; mock it
// to render the trigger + content inline so we can drive the real menu buttons.
vi.mock("@hermes/shared-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hermes/shared-ui")>();
  const Popover = {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Close: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
  return { ...actual, Popover };
});

beforeEach(() => cleanup());

const profile: ProfileSummary = {
  name: "default",
  path: "~/.hermes/profiles/default",
  is_default: true,
  model: "fake-model",
  provider: "custom",
  has_env: false,
  skill_count: 0,
  description: "",
  gateway_running: false,
  description_auto: false,
  distribution_name: null,
  distribution_version: null,
  distribution_source: null,
  has_alias: false,
};

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(async () => {}),
  },
});

describe("ProfileActionsMenu", () => {
  it("fires every action menu item", () => {
    const onEditModel = vi.fn();
    const onEditDescription = vi.fn();
    const onEditSoul = vi.fn();
    const onManageSkills = vi.fn();
    render(
      <ProfileActionsMenu
        profile={profile}
        isActive={false}
        onEditModel={onEditModel}
        onEditDescription={onEditDescription}
        onEditSoul={onEditSoul}
        onManageSkills={onManageSkills}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        fetchSetupCommand={vi.fn(async () => "hermes setup")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "default 的操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /改模型/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /改描述/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /编辑 SOUL\.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /管理技能/ }));
    expect(onEditModel).toHaveBeenCalledTimes(1);
    expect(onEditDescription).toHaveBeenCalledTimes(1);
    expect(onEditSoul).toHaveBeenCalledTimes(1);
    expect(onManageSkills).toHaveBeenCalledTimes(1);
    // default profile hides rename/delete
    expect(screen.queryByRole("menuitem", { name: /重命名/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /删除/ })).toBeNull();
  });

  it("copies the CLI setup command", async () => {
    const fetchSetupCommand = vi.fn(async () => "hermes setup --profile default");
    render(
      <ProfileActionsMenu
        profile={profile}
        isActive={false}
        onEditModel={vi.fn()}
        onEditDescription={vi.fn()}
        onEditSoul={vi.fn()}
        onManageSkills={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        fetchSetupCommand={fetchSetupCommand}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /复制 CLI 命令/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hermes setup --profile default"));
  });
});
