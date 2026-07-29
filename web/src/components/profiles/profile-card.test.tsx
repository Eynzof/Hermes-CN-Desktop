import type { ProfileSummary } from "@hermes/protocol";
import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProfileCard, type ProfileCardProps } from "./profile-card";

const profile: ProfileSummary = {
  name: "work",
  path: "/profiles/work",
  is_default: false,
  model: "deepseek-v4-pro",
  provider: "deepseek",
  has_env: true,
  skill_count: 12,
  gateway_running: false,
  description: "工作档案",
  description_auto: false,
  distribution_name: null,
  distribution_version: null,
  distribution_source: null,
  has_alias: true,
};

function renderCard(overrides: Partial<ProfileCardProps> = {}) {
  return ReactDOMServer.renderToStaticMarkup(
    <ProfileCard
      profile={profile}
      isActive={false}
      isSwitching={false}
      switchDisabled={false}
      onSetActive={vi.fn()}
      onEditModel={vi.fn()}
      onEditDescription={vi.fn()}
      onEditSoul={vi.fn()}
      onManageSkills={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      fetchSetupCommand={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ProfileCard", () => {
  it("exposes switching as a primary card action for inactive profiles", () => {
    const html = renderCard();

    expect(html).toContain('aria-label="切换到 work 档案"');
    expect(html).toContain(">切换</button>");
    expect(html).not.toContain("设为默认");
  });

  it("uses the current badge instead of a redundant switch button", () => {
    const html = renderCard({ isActive: true });

    expect(html).toContain(">当前</span>");
    expect(html).not.toContain("切换到 work 档案");
  });

  it("shows an accessible pending state while switching", () => {
    const html = renderCard({ isSwitching: true, switchDisabled: true });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("切换中…");
    expect(html).toContain("disabled");
  });
});
