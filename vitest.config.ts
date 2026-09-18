import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each database test creates a database of its own and spawns a worker that takes a
    // cluster-wide advisory lock; running files in parallel is fine, running the same file's
    // suites against one worker is not.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 180_000,
  },
});
