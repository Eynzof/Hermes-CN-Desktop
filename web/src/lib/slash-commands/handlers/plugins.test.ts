import { describe, expect, it, vi } from "vitest";
import { PluginRegistry } from "@hermes/agent-core";
import { handlePlugins, type PluginsHandlerContext } from "./plugins";

function makeContext(): { ctx: PluginsHandlerContext; navigated: string[] } {
  const registry = new PluginRegistry();
  const navigated: string[] = [];
  return {
    ctx: {
      registry,
      navigate: (to: string) => navigated.push(to),
    },
    navigated,
  };
}

describe("handlePlugins", () => {
  it("lists plugins", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "demo", version: "1.0.0", kind: "general" });

    const result = handlePlugins("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("demo");
    expect(result.output).toContain("Plugins");
  });

  it("reports status", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "demo", version: "1.0.0", kind: "general" }, "local", "", true);

    const result = handlePlugins("status", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Registered plugins: 1");
    expect(result.output).toContain("Enabled: 1");
  });

  it("enables a plugin", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "toggle", version: "1.0.0", kind: "general" }, "local", "", false);

    const result = handlePlugins("enable toggle", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Enabled plugin");
    expect(ctx.registry.get("toggle")?.enabled).toBe(true);
  });

  it("errors when enabling unknown plugin", () => {
    const { ctx } = makeContext();
    const result = handlePlugins("enable missing", ctx);
    expect(result.type).toBe("error");
    expect(result.message).toContain("not found");
  });

  it("disables a plugin", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "toggle", version: "1.0.0", kind: "general" }, "local", "", true);

    const result = handlePlugins("disable toggle", ctx);
    expect(result.type).toBe("exec");
    expect(ctx.registry.get("toggle")?.enabled).toBe(false);
  });

  it("reloads a plugin", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "reloadable", version: "1.0.0", kind: "general" });

    const result = handlePlugins("reload reloadable", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Reloaded plugin");
  });

  it("opens the plugins page", () => {
    const { ctx, navigated } = makeContext();
    const result = handlePlugins("open", ctx);
    expect(result.type).toBe("exec");
    expect(navigated).toContain("plugins");
  });

  it("returns help", () => {
    const { ctx } = makeContext();
    const result = handlePlugins("help", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Plugins commands");
    expect(result.output).toContain("/plugins enable");
  });

  it("rejects unknown subcommands", () => {
    const { ctx } = makeContext();
    const result = handlePlugins("foobar", ctx);
    expect(result.type).toBe("error");
    expect(result.message).toContain("Unknown /plugins subcommand");
  });

  it("lists enabled plugins", () => {
    const { ctx } = makeContext();
    ctx.registry.register({ name: "on", version: "1.0.0", kind: "general" }, "local", "", true);
    ctx.registry.register({ name: "off", version: "1.0.0", kind: "general" }, "local", "", false);

    const result = handlePlugins("enabled", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("on");
    expect(result.output).not.toContain("off");
  });
});
