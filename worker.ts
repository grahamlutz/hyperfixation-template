// First, and for effect: it fills `process.env` from `.env` before `./src/hyperfixation` is
// evaluated, which is where `defineApp()` reads `HF_BUILD_SHA`. Next loads `.env` for the web;
// this is the same for the two entrypoints Next never sees. Values already in the environment
// — compose's, and the `HF_BUILD_SHA` `hf dev` invents — win over the file.
import "./src/boot-env";
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

/**
 * The schedules, driven by a plain timer outside DBOS — the same shape `startReconciler()` has,
 * and for the same reason: a schedule starts a run and never sleeps durably, because a durable
 * sleep is a workflow parked across an `applicationVersion` boundary. `runs.start()` refuses to
 * be called from inside a run at all.
 *
 * `lastFired` lives in this process only. A worker that restarts fires everything once, which is
 * the cheap direction of the trade: `fire` is a `runs.start`, and every flow it starts is keyed,
 * so an extra firing converges instead of duplicating. A paused app starts nothing.
 *
 * `unref` so the timer is never itself the reason the process stays up, and the interval is the
 * tick rather than any schedule's period — `schedules.due()` is what compares the clock.
 */
const SCHEDULE_TICK_MS = 30_000;
const lastFired = new Map<string, Date>();

const tick = setInterval(() => {
  void (async () => {
    const now = new Date();
    for (const name of app.schedules.due(now, lastFired)) {
      try {
        const fired = await app.schedules.fire(name);
        if (fired.started) lastFired.set(name, now);
      } catch (error) {
        // A schedule that cannot start is this tick's problem, not the next one's, and never the
        // worker's: the run it would have started is re-derived from the clock in 30 seconds.
        console.error("hf-schedule: fire refused", name, error);
      }
    }
  })();
}, SCHEDULE_TICK_MS);
tick.unref();
