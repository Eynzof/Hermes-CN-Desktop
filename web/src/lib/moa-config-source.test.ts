import { describe, expect, it } from "vitest";
import { conflictsWithLegacy, inspectMoaYaml } from "./moa-config-source";

const flat = `
# A comment mentioning presets: {} must not hide the actual configuration.
moa:
  enabled: yes
  reference_models:
    - { provider: local, model: advisor, enabled: no, reasoning_effort: low }
  aggregator: { provider: local, model: final }
  fanout: {mode: every_n, n: 3}
  reference_timeout: 23
  privacy_filter: display
`;

describe("旧混合模型配置", () => {
  it("从原文件还原服务商和参考模型控制，识别实际路由差异", async () => {
    const source = await inspectMoaYaml(flat);
    if (source?.kind !== "legacy") throw new Error("未识别旧配置");
    expect(source.privacy).toBe(true);
    expect(source.preset).toMatchObject({
      enabled: true, reference_models: [{provider: "local", model: "advisor", enabled: false, reasoning_effort: "low"}],
      aggregator: {provider: "local", model: "final"}, fanout: "every_n:3", reference_timeout: 23,
    });
    const config = {default_preset: "default", active_preset: "", presets: {default: source.preset}};
    expect(conflictsWithLegacy(source, config)).toBe(false);
    expect(conflictsWithLegacy(source, {...config, presets: {default: {...source.preset, aggregator: {provider: "other", model: "other"}}}})).toBe(true);
  });

  it("尊重命名映射，无法确认的配置不显示警告", async () => {
    expect(await inspectMoaYaml("moa: {presets: {}, enabled: false}")).toEqual({kind: "named", names: []});
    expect(await inspectMoaYaml("moa: {presets: {team: {}}, enabled: false}")).toEqual({kind: "named", names: ["team"]});
    for (const yaml of ["", "moa: {save_traces: true}", "moa: {presets: null, enabled: false}", "moa: ["]) {
      expect(await inspectMoaYaml(yaml)).toBeNull();
    }
  });
});
