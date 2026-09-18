import { defineConfig } from "drizzle-kit";

/**
 * This app's own migrations, in the default tracking table. Core's live in
 * `drizzle.hf_core_migrations` and are applied by `@hyperfixation/db`'s migrator first, so the
 * two journals never collide — and an app migration that touches an `hf_*` table fails boot
 * check E005 rather than quietly diverging from the schema core believes it owns.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.MIGRATOR_DATABASE_URL ?? "postgres://localhost:5432/__DB_NAME__",
  },
});
