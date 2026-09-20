import { defineConfig } from "vitest/config";

/**
 * The exit-bar suite, kept out of `pnpm test` on purpose: it wants a browser, a built app and a
 * running compose, none of which the contract suite needs. `pnpm test:e2e` runs it.
 *
 * `prod-*.e2e.ts` is excluded for the same kind of reason one step further out: those build the
 * image and run the deployed stack, which wants Docker rather than a browser. `pnpm test:prod`
 * (`vitest.prod.config.ts`) is theirs.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/prod-*.e2e.ts"],
    fileParallelism: false,
    hookTimeout: 600_000,
    testTimeout: 300_000,
  },
});
