import { scrubEvent } from "./scrub";

/**
 * The worker's Sentry, and only the worker's: the web initialises `@sentry/nextjs` from
 * `instrumentation.ts`, which Next calls and which never runs here.
 *
 * Empty `SENTRY_DSN` is the whole no-op — not "init with no DSN", which still installs the
 * global handlers and the `beforeExit` session. The import itself is dynamic so a worker with
 * telemetry off does not pay for OpenTelemetry's require hooks to be told it is off.
 *
 * **ESM caveat.** Sentry's docs want `init()` before the modules it patches are loaded, which a
 * plain import cannot promise: ESM evaluates every import before any body, so the earliest this
 * can run is `src/boot-sentry.ts`, third in `worker.ts` — after `@sentry/node` itself but
 * before `@hyperfixation/workflows`. Auto-instrumentation of `pg`/`http` would need
 * `--import @sentry/node/preload` on the command line, in `pnpm worker` and the image's `CMD`
 * both. It buys nothing here: `tracesSampleRate` is 0, and error capture — the global handlers
 * and `captureException` — does not depend on any of those patches.
 */
export async function initSentry(): Promise<boolean> {
  if ((process.env.SENTRY_DSN ?? "") === "") return false;

  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.HF_BUILD_SHA,
    // The last thing to touch an event. Everything below narrows what is collected; this takes
    // this app's own secrets out of whatever was collected anyway — a crash message quoting a
    // connection string is how `SMTP_URL` reached an issue once.
    beforeSend: (event) => scrubEvent(event),
    // Errors only; the spans worth having are Langfuse's, which `startWorker()` registers and
    // which carry the run id the trace would otherwise be anonymous without.
    tracesSampleRate: 0,
    // No bodies, no gen-AI inputs or outputs, no database query values, no cookies or PII
    // headers — the switch that decides all of it, and the same one the web sets.
    sendDefaultPii: false,
    // The three it does not cover. `LocalVariables` attaches every frame's locals to an
    // exception, which in a failing step is the model's output and the draft it wrote; `Console`
    // turns this process's own logging — including `hf-schedule`'s — into breadcrumbs;
    // `ProcessSession` POSTs a session on `beforeExit`, and a worker shutting down inside
    // compose's grace period should not be waiting on Sentry to answer.
    integrations: (defaults) => defaults.filter((integration) => !WITHOUT.has(integration.name)),
  });
  return true;
}

const WITHOUT = new Set(["LocalVariables", "Console", "ProcessSession"]);
