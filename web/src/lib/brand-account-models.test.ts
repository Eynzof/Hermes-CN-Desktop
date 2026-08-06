import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.generated";
import {
  BRAND_ACCOUNT_PROVIDER_ID,
  isBrandAccountModel,
  isCurrentBrandAccountProvider,
  selectBrandAccountEndpointTypes,
  selectBrandAccountModels,
} from "./brand-account-models";

describe("brand account model allowlist", () => {
  it("keeps only brand JSON models in brand-defined order", () => {
    const reversed = [...BRAND.accountDefaultModels].reverse();
    expect(selectBrandAccountModels(["server-only-model", ...reversed])).toEqual(
      BRAND.accountDefaultModels,
    );
    expect(isBrandAccountModel("server-only-model")).toBe(false);
    expect(isBrandAccountModel(BRAND.accountDefaultModels[0])).toBe(true);
  });

  it("recognizes only the active brand account providers", () => {
    expect(isCurrentBrandAccountProvider(BRAND_ACCOUNT_PROVIDER_ID)).toBe(true);
    expect(isCurrentBrandAccountProvider(`${BRAND_ACCOUNT_PROVIDER_ID}-messages`)).toBe(true);
    expect(isCurrentBrandAccountProvider("custom:acct-another-brand")).toBe(false);
  });

  it("drops endpoint metadata for models outside the allowlist", () => {
    const model = BRAND.accountDefaultModels[0];
    expect(selectBrandAccountEndpointTypes({
      [model]: ["openai"],
      "server-only-model": ["anthropic"],
    }, [model])).toEqual({ [model]: ["openai"] });
  });
});
