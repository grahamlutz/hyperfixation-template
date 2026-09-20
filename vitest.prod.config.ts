import { defineConfig } from "vitest/config";

/**
 * The deployed-stack suites, kept out of both other configs: they build the image and run
 * `docker-compose.prod.yml`, so they need Docker and several minutes, where `pnpm test` needs a
 * Postgres and `pnpm test:e2e` a browser. `pnpm test:prod` runs them; CI's `image` job is the
 * one place all of it is already installed.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/prod-*.e2e.ts"],
    fileParallelism: false,
    // A cold `pnpm install` plus `next build` inside the image, twice over for a redeploy.
    hookTimeout: 1_200_000,
    testTimeout: 300_000,
  },
});
