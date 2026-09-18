/**
 * The env contract. `compose-envs.test.ts` asserts the `environment:` keys of `web`, `worker`
 * and `migrate` in `docker-compose.prod.yml` are exactly this list — all three, identically.
 *
 * All three rather than per-service subsets on purpose. A per-service list would let a var
 * silently reach one container and not another, which is precisely the failure the redeploy
 * sequence cannot see: `migrate` runs first and `worker` starts under a different role, so an
 * `HF_BUILD_SHA` that reached only `web` would deploy, serve, and report the wrong version.
 * One list, three identical blocks, one test — drift anywhere fails it.
 *
 * Adding a var is a three-line change: this list, both compose blocks, `.env.example`.
 */
export const REQUIRED_ENV = [
  /** `web` | `worker` | `migrate`. `startWorker()` refuses to launch DBOS unless it is `worker`. */
  "HF_PROCESS",
  /**
   * The version this deploy runs, from the `SOURCE_COMMIT` build arg. `defineApp()` reads it,
   * `startWorker()` refuses anything shorter than 7 characters, and `/api/status` reports it.
   */
  "HF_BUILD_SHA",
  /** The application role (`hf___APP_NAME__`): both worker pools, the lock, DBOS, and the web. */
  "DATABASE_URL",
  /** The migrator role. Only the `migrate` service connects with it; it owns every `hf_*` object. */
  "MIGRATOR_DATABASE_URL",
  /** The app's public origin: better-auth's base URL and the passkey relying-party origin. */
  "APP_URL",
  /** better-auth's signing secret. */
  "BETTER_AUTH_SECRET",
  /** Where `emailOTP` posts a code: mailpit in dev, Postmark in production. */
  "SMTP_URL",
  /** The envelope sender for that code. */
  "EMAIL_FROM",
  /** Sentry, initialised in the web (`instrumentation.ts`) and the worker (`worker.ts`). */
  "SENTRY_DSN",
  /** Langfuse's OTel span processor, registered in the same two places. */
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  /** Model providers `llm.run` resolves against. */
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type RequiredEnv = (typeof REQUIRED_ENV)[number];

export class MissingEnv extends Error {
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super(`MissingEnv: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} unset`);
    this.name = "MissingEnv";
    this.names = names;
  }
}

/**
 * Reads one var or throws. Deliberately not a "validate everything at boot" pass: `migrate`
 * has no use for a provider key and the worker has no use for the migrator role, so a blanket
 * check would turn compose's one honest list into a false boot failure. Each entrypoint reads
 * what it uses, and the compose test is what keeps the list itself honest.
 */
export function requireEnv(name: RequiredEnv): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new MissingEnv([name]);
  return value;
}
