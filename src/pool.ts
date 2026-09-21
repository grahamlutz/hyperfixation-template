import { Pool } from "pg";
import { requireEnv } from "./env";

/**
 * The web's one pool, in a module of its own so that asking for it does not import the app.
 *
 * `src/web.ts` is where it used to live, beside `attachedApp()` — and `src/auth.ts` reads it, so
 * every route in this app reached `src/hyperfixation.ts` and `src/flows/*` through the guard,
 * `/auth/*` included. `next build --webpack` compiles a route's graph once per module layer, so
 * a route that needs no flow got a second copy of every `defineFlow` call in the process, and
 * `/auth/passkey` — a page whose server action promotes the session it just rendered for — is
 * where the two copies met. `tests/e2e/layers.e2e.ts` is what holds this.
 *
 * Opened on the first call rather than at import: `next build` imports every route module to
 * collect its metadata, and a pool opened there would connect at build time, when there may be
 * no database at all.
 */

/** Matches the plan's connection budget: web Drizzle/better-auth pool 5, web `DBOSClient` 2. */
const WEB_POOL_SIZE = 5;

let webPool: Pool | undefined;

export function pool(): Pool {
  webPool ??= new Pool({ connectionString: requireEnv("DATABASE_URL"), max: WEB_POOL_SIZE });
  return webPool;
}
