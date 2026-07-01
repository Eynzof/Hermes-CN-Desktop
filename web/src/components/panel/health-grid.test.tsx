import { describe, expect, it } from "vitest";

import { summarizeProviderConfig } from "./health-grid";

describe("summarizeProviderConfig", () => {
  it("marks a custom-only local provider flow as configured", () => {
    const fakeConfig = {
      model: {
        provider: "custom:lm-studio",
        default: "local-model",
      },
      custom_providers: [
        {
          name: "LM Studio",
          base_url: "http://localhost:1234/v1",
          model: "local-model",
        },
      ],
    };
    const fakeEnvTokensSet = false;
    const fakeOAuthLoggedIn = false;

    const summary = summarizeProviderConfig(fakeConfig);
    const providersOk = fakeOAuthLoggedIn || (summary.providerTotal > 0 && summary.invalidProviders.length === 0);
    const modelCredentialsOk = fakeEnvTokensSet || fakeOAuthLoggedIn || summary.hasCredentials;

    expect(providersOk).toBe(true);
    expect(modelCredentialsOk).toBe(true);
    expect(summary.providerTotal).toBe(1);
  });

  it("counts legacy custom_providers as configured", () => {
    const summary = summarizeProviderConfig({
      custom_providers: [
        {
          name: "Local",
          base_url: "http://127.0.0.1:1234/v1",
          model: "local-model",
        },
      ],
    });

    expect(summary.providerTotal).toBe(1);
    expect(summary.invalidProviders).toEqual([]);
    expect(summary.hasCredentials).toBe(true);
  });

  it("counts bare model custom base_url config as a provider", () => {
    const summary = summarizeProviderConfig({
      model: {
        provider: "custom",
        default: "local-chat",
        base_url: "http://localhost:11434/v1",
      },
    });

    expect(summary.providerTotal).toBe(1);
    expect(summary.hasCredentials).toBe(true);
  });

  it("still flags api_key values that look like URLs", () => {
    const summary = summarizeProviderConfig({
      custom_providers: [
        {
          name: "Bad",
          base_url: "https://api.example.com/v1",
          model: "bad-model",
          api_key: "https://api.example.com/v1",
        },
      ],
    });

    expect(summary.invalidProviders).toEqual(["Bad"]);
    expect(summary.hasCredentials).toBe(false);
  });
});
