import { describe, expect, it } from "vitest";
import { PROFILE_AWARE_QUERY_KEYS } from "./use-profiles";
import {
  PLUGINS_QUERY_KEY,
  pluginActionPath,
  pluginPath,
  pluginRemovePath,
} from "./use-plugins";

describe("plugin API paths", () => {
  it("逐段编码嵌套插件 key 并保留路径分隔符", () => {
    expect(pluginPath("image gen/openai+codex")).toBe("image%20gen/openai%2Bcodex");
    expect(pluginActionPath("image gen/openai+codex", "enable")).toBe(
      "/api/dashboard/agent-plugins/image%20gen/openai%2Bcodex/enable",
    );
    expect(pluginRemovePath("image gen/openai+codex")).toBe(
      "/api/dashboard/agent-plugins/image%20gen/openai%2Bcodex",
    );
  });

  it("切换 Profile 时会失效 Plugins Hub 缓存", () => {
    expect(PROFILE_AWARE_QUERY_KEYS).toContain(PLUGINS_QUERY_KEY);
  });
});
