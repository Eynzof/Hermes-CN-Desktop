import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Node is the default sandbox; hook/component tests that need a DOM opt in
    // per-file with `// @vitest-environment jsdom` (jsdom is hoisted at the repo
    // root, so it resolves without an install).
    environment: "node",
  },
});
