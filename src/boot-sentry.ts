import { initSentry } from "./sentry";

/**
 * Imported for effect by `worker.ts`, below `./src/boot-env` — the DSN comes out of `.env`, so
 * it has to be loaded first, and everything Sentry should see loaded has to come after. The
 * top-level await is what makes "after" true: ESM finishes this module, init and all, before it
 * evaluates the next import in `worker.ts`.
 */
await initSentry();
