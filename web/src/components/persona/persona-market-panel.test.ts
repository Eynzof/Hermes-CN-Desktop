import { describe, expect, it } from "vitest";
import {
  PERSONA_OVERWRITE_DIALOG_DESCRIPTION,
  PERSONA_OVERWRITE_DIALOG_TITLE,
  shouldConfirmPersonaOverwrite,
} from "./persona-market-panel";

describe("persona overwrite confirmation", () => {
  it("requires confirmation for saved or unsaved existing personality content", () => {
    expect(shouldConfirmPersonaOverwrite("已有内容", false)).toBe(true);
    expect(shouldConfirmPersonaOverwrite("", true)).toBe(true);
    expect(shouldConfirmPersonaOverwrite("   ", false)).toBe(false);
  });

  it("uses explicit overwrite copy in the modal", () => {
    expect(PERSONA_OVERWRITE_DIALOG_TITLE).toBe("覆盖当前人格？");
    expect(PERSONA_OVERWRITE_DIALOG_DESCRIPTION).toContain("当前人格不为空");
    expect(PERSONA_OVERWRITE_DIALOG_DESCRIPTION).toContain("完整替换");
  });
});
