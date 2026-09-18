// First, and for effect — see `worker.ts`. The same gap: `pnpm migrate` is a plain Node process
// and Next loads `.env` for nobody but the web.
import "./src/boot-env";
import path from "node:path";
import { migrate } from "@hyperfixation/db/migrator";
import { requireEnv } from "./src/env";
import { app, recordTables } from "./src/hyperfixation";

/**
 * The one-shot `migrate` service, run as the migrator role on every deploy — not only on the
 * deploys that added a migration. The migrator's `dbos schema -s dbos -r hf_<app>` step is
 * why: an SDK upgrade that adds a system table has to be granted to the application role
 * *before* the worker that needs it starts, and the only deploy that knows an upgrade happened
 * is the one that shipped it.
 *
 * `web` and `worker` both depend on this completing successfully, so a non-zero exit here
 * stops the deploy instead of producing a worker that fails E001–E006 one container later.
 */
const result = await migrate(requireEnv("MIGRATOR_DATABASE_URL"), {
  appName: app.name,
  recordTables,
  appMigrationsDir: path.resolve(process.cwd(), "drizzle"),
});

console.log(`hf-migrate: ${JSON.stringify(result)}`);
