/**
 * The web's telemetry, and only the web's: Next calls this once per server process before any
 * request. The worker registers the same two things from `worker.ts`, because `startWorker()`
 * is its entrypoint and Next never runs there.
 *
 * `DBOS.launch()` must never happen here — `HF_PROCESS` is `web` in this process and
 * `startWorker()` refuses on that, but the rule is worth stating where someone would break it.
 */

/**
 * The same three names as `LANGFUSE_ENV` in `@hyperfixation/workflows`, repeated rather than
 * imported: the gate has to be decidable before the dynamic import, or a web process with
 * telemetry off still loads the OTel SDK to be told so. `registerLangfuse` re-checks them, so
 * core stays the authority on what "configured" means and this copy can only be stricter.
 */
const LANGFUSE_ENV = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] as const;

/** Next may call `register()` more than once in a process; a second provider would double-export. */
let langfuseRegistered = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const sentryDsn = process.env.SENTRY_DSN;
  if (sentryDsn !== undefined && sentryDsn !== "") {
    // TODO(phase 2): @sentry/nextjs, once the DSN is provisioned by `hf new`.
  }

  if (langfuseRegistered) return;
  if (LANGFUSE_ENV.some((name) => (process.env[name] ?? "") === "")) return;

  // Dynamic, and below the runtime guard: `@hyperfixation/workflows` reaches DBOS and Node's
  // own `async_hooks`, neither of which resolves on the edge runtime, and a static import puts
  // it in that bundle's module graph whether or not this function runs.
  const { registerLangfuse } = await import("@hyperfixation/workflows");
  langfuseRegistered = registerLangfuse() !== undefined;
}
