/**
 * The worker the contract suite spawns: a real process running the app's real entrypoint
 * logic, because `startWorker()` cannot be tested in-process — DBOS refuses a second launch,
 * and the advisory lock is released by process death and nothing else.
 *
 * It differs from `worker.ts` in two ways: the app name and database URL come from the harness's
 * per-test database rather than from the environment, and it starts no schedule tick — a schedule
 * firing mid-test would start runs whose rows the restart assertion counts. Everything the
 * assertion depends on — the flow registrations, the step pool's fence, `HF_PROCESS=worker` — is
 * the production path.
 */
import path from "node:path";
import { startWorker } from "@hyperfixation/workflows";
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { app, recordTables } from "../src/hyperfixation";
import { approvalNotifier } from "../src/notify";

// The notifier's link origin. `pnpm test` serves nothing, so any well-formed origin does; the
// e2e's own `APP_URL` is already in the environment this process inherits, and wins.
if ((process.env.APP_URL ?? "") === "") process.env.APP_URL = "http://localhost:3000";

await runWorkerModule({
  start: async ({ appName, databaseUrl }) => {
    const worker = await startWorker({
      appName,
      databaseUrl,
      recordTables,
      appMigrationsDir: path.resolve(process.cwd(), "drizzle"),
      approvalNotifier: approvalNotifier(),
    });
    app.attach({ pool: worker.control.pool, client: worker.client });
    return worker;
  },
});
