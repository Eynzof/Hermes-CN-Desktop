import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.generated";
import {
  enterpriseProviderIdsFromConfig,
  savedCustomProviderIdsFromConfig,
} from "./model-provider-visibility";

describe("savedCustomProviderIdsFromConfig", () => {
  it("keeps user entries and excludes account and Team-managed providers", () => {
    const ids = savedCustomProviderIdsFromConfig({
      providers: {
        "custom:my-endpoint": { base_url: "http://localhost:3000/v1" },
        [`custom:${BRAND.providerKey}`]: { base_url: "https://account.example/v1" },
        "custom:old-brand": { base_url: "https://old.example/v1", token_id: 7 },
      },
      custom_providers: [
        {
          provider_key: "legacy-user",
          base_url: "http://localhost:4000/v1",
        },
        {
          provider_key: "team-model",
          base_url: "https://team.example/v1",
          team_managed: true,
        },
      ],
    });

    expect(Array.from(ids)).toEqual([
      "custom:my-endpoint",
      "custom:legacy-user",
    ]);
  });
});

describe("enterpriseProviderIdsFromConfig", () => {
  it("includes the friendly-name slugs emitted by Core for Team-managed entries", () => {
    const ids = enterpriseProviderIdsFromConfig({
      custom_providers: [
        {
          provider_key: "team-mdl_opaque_one",
          name: "rightcodegpt",
          team_managed: true,
        },
        {
          provider_key: "team-mdl_opaque_two",
          name: "GPT 5.6",
          team_managed: true,
        },
      ],
    });

    expect(Array.from(ids)).toEqual([
      "custom:team-mdl_opaque_one",
      "custom:rightcodegpt",
      "custom:team-mdl_opaque_two",
      "custom:gpt-5.6",
    ]);
  });
});
