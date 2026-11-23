import { describe, expect, it } from "vitest";
import {
  buildGatewayModelConfigValue,
} from "./provider-id";

describe("buildGatewayModelConfigValue", () => {
  it("includes an explicit provider flag for gateway model switches", () => {
    expect(buildGatewayModelConfigValue("kimi-k2.6", "kimi-for-coding"))
      .toBe("kimi-k2.6 --provider kimi-for-coding");
  });

  it.each(["custom:api.example.com", "custom:cp.compshare.cn"])(
    "preserves the advertised domain-shaped route %s",
    (route) => {
      expect(buildGatewayModelConfigValue("deepseek-v4-flash", route))
        .toBe(`deepseek-v4-flash --provider ${route}`);
    },
  );
});
