/**
 * The other half of `skipOpenTelemetrySetup: true`, and the reason both inits can carry it.
 *
 * Skipping the setup leaves the trace global to Langfuse, which is the point — but Sentry's
 * `_init` installs its async-context strategy either way, and that strategy is a thin shell over
 * `context.with()`: `withScope`/`withIsolationScope` fork by putting the forked scopes *on the
 * OpenTelemetry context*, and the piece that carries them there is `SentryContextManager`, which
 * the skipped setup never registers. With OpenTelemetry's own `AsyncLocalStorageContextManager`
 * on the global — the one `provider.register()` installs — nothing puts scopes on the context,
 * `getScopesFromContext()` finds none, and both calls fall through to the *process-global* default
 * scope and mutate it. Measured: two concurrent `withIsolationScope` tasks tagging `req` both read
 * back `"b"`, and `req=b` is still on the default isolation scope afterwards, so a tag set while
 * handling one request rides out on every later request's event.
 *
 * So Sentry gets the context global and Langfuse keeps the trace global — the two are separate
 * slots, and neither SDK needs the other's. This has to run before `registerLangfuse()`:
 * `setGlobalContextManager` is first-one-wins like every other OpenTelemetry global, which is what
 * makes `provider.register()`'s own unconditional attempt a silent no-op rather than a fight.
 *
 * Both `initSentry()`s call this, and only past their own DSN gate — with no `init()` there is no
 * Sentry strategy to repair, and `@sentry/core`'s default one forks on a stack of its own.
 */
export async function installSentryContextManager(): Promise<boolean> {
  // `webpackIgnore` for the reason `instrumentation.ts` gives: neither of these survives that
  // compilation — `@sentry/node` pulls OpenTelemetry's require hooks — and the web reaches this
  // module from the instrumentation hook.
  const { SentryContextManager } = await import(/* webpackIgnore: true */ "@sentry/node");
  const { context } = await import(/* webpackIgnore: true */ "@opentelemetry/api");

  const manager = new SentryContextManager();
  manager.enable();
  return context.setGlobalContextManager(manager);
}
