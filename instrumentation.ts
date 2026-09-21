/**
 * The web's telemetry, and only the web's: Next calls this once per server process before any
 * request. The worker registers the same two things from `worker.ts`, because `startWorker()`
 * is its entrypoint and Next never runs there.
 *
 * `DBOS.launch()` must never happen here — `HF_PROCESS` is `web` in this process and
 * `startWorker()` refuses on that, but the rule is worth stating where someone would break it.
 */

// Static, unlike the two below it: `src/scrub.ts` reads `process.env` and nothing else, so it
// resolves on either runtime and adds nothing to the edge bundle worth deferring.
import { installConsoleScrub, scrubEvent } from "./src/scrub";

/**
 * The same three names as `LANGFUSE_ENV` in `@hyperfixation/workflows`, repeated rather than
 * imported: the gate has to be decidable before the dynamic import, or a web process with
 * telemetry off still loads the OTel SDK to be told so. `registerLangfuse` re-checks them, so
 * core stays the authority on what "configured" means and this copy can only be stricter.
 */
const LANGFUSE_ENV = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] as const;

/** Next may call `register()` more than once in a process; a second provider would double-export. */
let langfuseRegistered = false;
/** Same for Sentry: a second `init()` replaces the client the first one's handlers already hold. */
let sentryInitialised = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Before Sentry, and unconditional: it costs nothing when no secret is set, and a process
  // with the DSN unset still logs.
  installConsoleScrub();
  await initSentry();

  if (langfuseRegistered) return;
  if (LANGFUSE_ENV.some((name) => (process.env[name] ?? "") === "")) return;

  // Dynamic, and below the runtime guard: `@hyperfixation/workflows` reaches DBOS and Node's
  // own `async_hooks`, neither of which resolves on the edge runtime, and a static import puts
  // it in that bundle's module graph whether or not this function runs.
  //
  // `webpackIgnore` because a dynamic import is not enough on its own: `serverExternalPackages`
  // does not reach the instrumentation hook's own compilation, so without this webpack follows
  // the specifier into `pg` and fails the whole build on `Can't resolve 'fs'` — which serves
  // every page a 500 in dev, whether or not Langfuse is configured.
  const { registerLangfuse } = await import(/* webpackIgnore: true */ "@hyperfixation/workflows");
  langfuseRegistered = registerLangfuse() !== undefined;
}

/**
 * Nothing at all when `SENTRY_DSN` is empty — not even the import, which is what keeps a build
 * with the DSN unset from loading the SDK into the prerender. `register()` runs during
 * `next build` too, so anything this reaches for has to be inert offline.
 *
 * `webpackIgnore` for the same reason the Langfuse import has it: `@sentry/nextjs` pulls
 * OpenTelemetry's require hooks, which webpack cannot follow, and the instrumentation hook's
 * compilation does not read `serverExternalPackages`.
 */
async function initSentry(): Promise<void> {
  if (sentryInitialised) return;
  if ((process.env.SENTRY_DSN ?? "") === "") return;

  const Sentry = await import(/* webpackIgnore: true */ "@sentry/nextjs");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.HF_BUILD_SHA,
    // The trace global belongs to Langfuse, and every OTel global is first-one-wins: `register()`
    // above awaits this fourteen lines before `registerLangfuse()`, so without this Sentry's own
    // provider takes it, that registration is refused without a word, and every `gen_ai` span goes
    // nowhere. Sentry only wanted it to sample traces this app does not collect.
    skipOpenTelemetrySetup: true,
    // The last thing to touch an event, and the worker sets the same one: everything below
    // narrows what is collected, this takes this app's own secrets out of what was collected
    // anyway — a crash message quoting a connection string is how `SMTP_URL` reached an issue
    // once. No `beforeSendTransaction`: `tracesSampleRate` is 0, so there is no transaction.
    beforeSend: (event) => scrubEvent(event),
    // Errors only. A trace would sample the request that carried a draft through the workspace,
    // and the spans worth having are Langfuse's, which already carry the run.
    tracesSampleRate: 0,
    // Which is what makes `RequestData` safe to keep: with PII off, the SDK collects no request
    // or response body at all, denies the PII headers and cookies, and sends no gen-AI input or
    // output — so an approval's edited draft cannot ride out on the request that failed. What it
    // leaves on is the URL and the route, which is the reason to report at all.
    sendDefaultPii: false,
    integrations: (defaults) => defaults.filter((integration) => !WITHOUT.has(integration.name)),
  });
  sentryInitialised = true;
}

/**
 * The three the PII switch does not cover. `LocalVariables` is the loud one: `stackFrameVariables`
 * stays true with PII off, and the locals of a failing step are the model's output and the draft
 * it wrote. `Console` turns the app's own logging into breadcrumbs. `ProcessSession` is not about
 * payloads at all — it ends a session on `beforeExit`, which is a POST from `next build` itself.
 */
const WITHOUT = new Set(["LocalVariables", "Console", "ProcessSession"]);

/**
 * Next's own hook, and the only thing that reports a server error: nothing here wraps route
 * handlers or server components at build time (no `withSentryConfig`), so this export is what
 * turns a thrown error into an event.
 */
export async function onRequestError(...args: Parameters<CaptureRequestError>): Promise<void> {
  if (!sentryInitialised) return;
  const { captureRequestError } = await import(/* webpackIgnore: true */ "@sentry/nextjs");
  captureRequestError(...args);
}

type CaptureRequestError = typeof import("@sentry/nextjs").captureRequestError;
