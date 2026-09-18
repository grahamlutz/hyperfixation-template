/**
 * The web's telemetry, and only the web's: Next calls this once per server process before any
 * request. The worker registers the same two things from `worker.ts`, because `startWorker()`
 * is its entrypoint and Next never runs there.
 *
 * `DBOS.launch()` must never happen here — `HF_PROCESS` is `web` in this process and
 * `startWorker()` refuses on that, but the rule is worth stating where someone would break it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const sentryDsn = process.env.SENTRY_DSN;
  if (sentryDsn !== undefined && sentryDsn !== "") {
    // TODO(phase 2): @sentry/nextjs, once the DSN is provisioned by `hf new`.
  }

  const langfuseKey = process.env.LANGFUSE_PUBLIC_KEY;
  if (langfuseKey !== undefined && langfuseKey !== "") {
    // TODO(phase 2): register Langfuse's OTel span processor, the web half of the pair
    // `startWorker()` registers in the worker.
  }
}
