import { installConsoleScrub } from "./scrub";

/**
 * Imported for effect by `worker.ts`, between `./src/boot-env` and `./src/boot-sentry`: the
 * secrets it removes come out of `.env`, and everything whose failures are worth filtering is
 * imported below it.
 */
installConsoleScrub();
