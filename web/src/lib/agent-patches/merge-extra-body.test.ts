/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { mergeModelExtraBody } from "./merge-extra-body";

describe("mergeModelExtraBody", () => {
  it("merges model.extra_body into request overrides", () => {
    const out = mergeModelExtraBody(
      {},
      { extra_body: { frequency_penalty: 0.15 } },
    );
    expect(out).toEqual({ extraBody: { frequency_penalty: 0.15 } });
  });

  it("keeps caller override on conflict and merges siblings", () => {
    const out = mergeModelExtraBody(
      { extraBody: { frequency_penalty: 0.5 } },
      { extra_body: { frequency_penalty: 0.15, presence_penalty: 0.2 } },
    );
    expect(out.extraBody).toEqual({
      frequency_penalty: 0.5,
      presence_penalty: 0.2,
    });
  });

  it("deep-merges nested objects", () => {
    const out = mergeModelExtraBody(
      { extraBody: { thinking: { keep: true } } },
      { extra_body: { thinking: { budget: 100 }, top_p: 0.9 } },
    );
    expect(out.extraBody).toEqual({
      thinking: { budget: 100, keep: true },
      top_p: 0.9,
    });
  });

  it("is a no-op when model.extra_body is missing or invalid", () => {
    const base = { service_tier: "priority" };
    for (const cfg of [
      {},
      { extra_body: {} },
      { extra_body: null },
      "not-a-dict",
      null,
    ]) {
      const out = mergeModelExtraBody(
        { ...base },
        cfg as { extra_body?: Record<string, unknown> },
      );
      expect(out).toEqual(base);
    }
  });

  it("does not mutate the source config", () => {
    const modelCfg = { extra_body: { frequency_penalty: 0.15 } };
    const out = mergeModelExtraBody({}, modelCfg);
    (out.extraBody as Record<string, unknown>).frequency_penalty = 0.99;
    expect(modelCfg.extra_body?.frequency_penalty).toBe(0.15);
  });
});
