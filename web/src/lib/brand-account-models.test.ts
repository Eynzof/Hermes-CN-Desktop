import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.generated";
const TEST_BRAND_MODELS = BRAND.accountDefaultModels.length > 0
  ? [...BRAND.accountDefaultModels]
  : ["ccwork-model-a", "ccwork-model-b"];

import {
  BRAND_ACCOUNT_PROVIDER_ID,
  isBrandAccountModel,
  isCurrentBrandAccountProvider,
  selectBrandAccountEndpointTypes,
  selectBrandAccountModels,
} from "./brand-account-models";

describe("brand account model allowlist", () => {
  it("keeps only brand JSON models in brand-defined order", () => {
    const reversed = [...TEST_BRAND_MODELS].reverse();
    const selected = selectBrandAccountModels(["server-only-model", ...reversed]);
    expect(selected).toEqual(BRAND.accountBackend === "ccwork"
      ? ["server-only-model", ...reversed]
      : TEST_BRAND_MODELS);
    expect(isBrandAccountModel("server-only-model")).toBe(false);
    expect(isBrandAccountModel(TEST_BRAND_MODELS[0])).toBe(BRAND.accountBackend !== "ccwork");
  });

  it("recognizes only the active brand account providers", () => {
    expect(isCurrentBrandAccountProvider(BRAND_ACCOUNT_PROVIDER_ID)).toBe(true);
    expect(isCurrentBrandAccountProvider(`${BRAND_ACCOUNT_PROVIDER_ID}-messages`)).toBe(true);
    expect(isCurrentBrandAccountProvider("custom:acct-another-brand")).toBe(false);
  });

  it("drops endpoint metadata for models outside the allowlist", () => {
    const model = TEST_BRAND_MODELS[0];
    const result = selectBrandAccountEndpointTypes({
      [model]: ["openai"],
      "server-only-model": ["anthropic"],
    }, [model]);
    expect(result).toEqual({ [model]: ["openai"] });
  });
});
