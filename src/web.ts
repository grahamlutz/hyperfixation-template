import { getClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { requireEnv } from "./env";
import { app, recordTables } from "./hyperfixation";

/**
 * The web's half of `app.attach()`: an ordinary pool under the application role, and the
 * `DBOSClient` singleton `getClient()` owns. The web never calls `DBOS.launch()` — it enqueues
 * through that client and nothing else.
 *
 * Attached lazily, on the first request that needs a control-plane operation rather than at
 * import: `next build` imports every route module to collect its metadata, and a pool opened
 * there would connect at build time, when there may be no database at all.
 */

/** Matches the plan's connection budget: web Drizzle/better-auth pool 5, web `DBOSClient` 2. */
const WEB_POOL_SIZE = 5;

let attached: Promise<void> | undefined;
let webPool: Pool | undefined;

export function pool(): Pool {
  webPool ??= new Pool({ connectionString: requireEnv("DATABASE_URL"), max: WEB_POOL_SIZE });
  return webPool;
}

export async function attachedApp(): Promise<typeof app> {
  attached ??= (async () => {
    const client = await getClient({
      appName: app.name,
      databaseUrl: requireEnv("DATABASE_URL"),
      recordTables,
    });
    app.attach({ pool: pool(), client });
  })().catch((error: unknown) => {
    // A failed attach caches nothing, so the next request retries rather than being told
    // forever that the app is not attached.
    attached = undefined;
    throw error;
  });
  await attached;
  return app;
}
