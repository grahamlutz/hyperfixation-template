import { loadEnv } from "./load-env";

/**
 * Imported for effect, and imported **first**, by `worker.ts` and `migrate.ts`.
 *
 * The position is the whole point. ESM evaluates a module's imports before its body, and
 * `defineApp()` reads `HF_BUILD_SHA` while `src/hyperfixation.ts` is being evaluated — so a
 * `loadEnv()` call in an entrypoint's body would run after the version had already been read as
 * `undefined`. A side-effecting import placed above `./src/hyperfixation` runs before it.
 */
loadEnv();
