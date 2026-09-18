import { defineConfig } from "vitest/config";

/**
 * The exit-bar suite, kept out of `pnpm test` on purpose: it wants a browser, a built app and a
 * running compose, none of which the contract suite needs. `pnpm test:e2e` runs it.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    hookTimeout: 600_000,
    testTimeout: 300_000,
  },
});
