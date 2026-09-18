import path from "node:path";
import { startWorker } from "@hyperfixation/workflows";
import { requireEnv } from "./src/env";
import { app, recordTables } from "./src/hyperfixation";

/**
 * The worker container's entrypoint, and the only process in the app that reaches
 * `DBOS.launch()`. `startWorker()` refuses unless `HF_PROCESS=worker`, runs E001–E006, takes
 * the app's advisory lock, and installs the SIGTERM handler — the one that must settle inside
 * compose's `stop_grace_period: 90s`.
 *
 * Importing the app registers its flows, which has to happen before the launch: DBOS recovery
 * can dispatch a workflow the instant `launch()` returns, and a flow it has no registration
 * for is a run that never moves.
 *
 * Nothing here catches. A worker that cannot prove it is alone, or cannot name the version it
 * is running, must exit non-zero rather than serve.
 */

// Resolved against the working directory rather than this module: the Dockerfile puts the
// compiled entrypoint in `dist/` and the migrations beside it at `/app/drizzle`, and both the
// container and `pnpm worker` run from the app root.
const APP_MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

const worker = await startWorker({
  appName: app.name,
  databaseUrl: requireEnv("DATABASE_URL"),
  recordTables,
  appMigrationsDir: APP_MIGRATIONS_DIR,
});

// The worker's control plane: the pool `startWorker()` built and its own `DBOSClient`. The web
// attaches the other pair. No export of any package resolves to this pool; it exists only here.
app.attach({ pool: worker.control.pool, client: worker.client });
