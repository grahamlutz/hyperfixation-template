import { getClient } from "@hyperfixation/workflows";
import { requireEnv } from "./env";
import { app, recordTables } from "./hyperfixation";
import { pool } from "./pool";

/**
 * The web's half of `app.attach()`: the `DBOSClient` singleton `getClient()` owns, over
 * `src/pool.ts`'s pool. The web never calls `DBOS.launch()` — it enqueues through that client
 * and nothing else.
 *
 * Importing this module is importing the app, and so every `defineFlow` in it: the pool lives
 * next door precisely so that a route wanting only a connection does not. See `src/pool.ts`.
 *
 * Attached lazily, on the first request that needs a control-plane operation rather than at
 * import: `next build` imports every route module to collect its metadata, and an attach there
 * would connect at build time, when there may be no database at all.
 */

let attached: Promise<void> | undefined;

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
