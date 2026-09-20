/**
 * The app's secrets, removed from anything on its way to a human or to Sentry.
 *
 * A real box, 2026-09-20: a `TypeError` whose message quoted the whole `SMTP_URL` — Cloudflare
 * API token included — reached the container log and Sentry. `src/email.ts` no longer builds
 * such a message, but that is one throw site out of every throw site, and the next one will be
 * somewhere else. This is the other half: whatever the text says, the values this process was
 * given are taken out of it before it leaves.
 *
 * It is not a secret *detector*. It only knows what `process.env` holds, so a credential this
 * app was never handed — one a library invented, one inside a request body — is not its subject.
 *
 * `src/email.ts` keeps a `scrub` of its own, deliberately: it re-reads `SMTP_URL` on every call
 * rather than caching, and it leaves a userinfo-less URL alone so a refusal can quote the shape
 * the operator should have typed. This one is the blanket, that one is the lock on one door.
 */

/**
 * Names whose value is treated as a credential. The list is deliberately broad — a false
 * redaction costs a log line some detail, a missed one costs a rotation.
 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|SMTP_URL|DATABASE_URL|_URL$)/i;

/**
 * The names the pattern above catches that are not credentials at all. `APP_URL` is this app's
 * public origin and `LANGFUSE_BASE_URL` names where a service is, not how to reach it; both
 * appear in the messages an operator most needs to read. `NEXT_PUBLIC_*` is shipped to every
 * browser by definition, so redacting it would only hide it from the log.
 *
 * `SENTRY_DSN` needs no entry: no part of its name matches, so it is never collected.
 */
const PUBLIC_NAME = /^(APP_URL|NEXT_PUBLIC_.*|.*_BASE_URL)$/i;

/** Below this a "secret" is too short to redact without mangling the text it protects. */
const MIN_SECRET = 8;

interface Secret {
  name: string;
  value: string;
}

let collected: Secret[] | undefined;

/**
 * Collected once, at first use rather than at import: `worker.ts` fills `process.env` from
 * `.env` in `boot-env`, and a module that read the environment while being imported would be
 * collecting whatever was there before that.
 *
 * Longest first, so a URL is redacted as a whole before its own password can eat a piece of it
 * and leave the rest of the URL — and the name — behind.
 */
function secrets(): Secret[] {
  if (collected !== undefined) return collected;
  const found = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || PUBLIC_NAME.test(name) || !SECRET_NAME.test(name)) continue;
    for (const part of [value, ...userinfo(value)]) {
      if (part.length >= MIN_SECRET && !found.has(part)) found.set(part, name);
    }
  }
  collected = [...found]
    .map(([value, name]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length);
  return collected;
}

/**
 * A URL-shaped value's credential parts, because a connection string is quoted whole in one
 * error and as its password alone in the next. Percent-decoded too: a token pasted with a `/`
 * in it is stored encoded and thrown decoded.
 */
function userinfo(value: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [];
  }
  const parts = [parsed.username, parsed.password].flatMap((part) =>
    part === "" ? [] : [part, decode(part)],
  );
  return [...new Set(parts)];
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Every occurrence of every secret replaced by the name that held it — which is the useful half
 * of the message: an operator reading `[redacted:SMTP_URL]` knows which credential the failure
 * was about and which one to rotate.
 *
 * `split`/`join` rather than a regex, so a secret holding `.` or `$` needs no escaping and
 * cannot become a pattern. Idempotent: what is left behind holds no secret to find again.
 */
export function scrub(text: string): string {
  let scrubbed = text;
  for (const { name, value } of secrets()) {
    scrubbed = scrubbed.split(value).join(`[redacted:${name}]`);
  }
  return scrubbed;
}

/**
 * The same over a Sentry event: every string anywhere in it, in place. The event is a tree of
 * plain JSON by the time `beforeSend` sees it — the message, each exception's `value`, every
 * frame's `vars`, `extra`, `contexts`, the breadcrumbs — and naming those paths would be a list
 * that goes stale with the next SDK. Nothing but a string is touched.
 */
export function scrubEvent<T>(event: T): T {
  walk(event, new WeakSet());
  return event;
}

function walk(node: unknown, seen: WeakSet<object>): void {
  if (typeof node !== "object" || node === null || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") (node as Record<string, unknown>)[key] = scrub(value);
    else walk(value, seen);
  }
}

let wrapped = false;

/**
 * `console.error` and `console.warn` put through the same filter, once per process: the web
 * calls this from `instrumentation.ts`, the worker from `src/boot-scrub.ts`. Only those two —
 * `log`/`info` carry the app's own lines, and the argument every unexpected value arrives in is
 * an error.
 *
 * An `Error` argument is printed as its scrubbed stack rather than scrubbed in place: the
 * caller usually still holds it, and a logger must not edit what its caller may rethrow.
 */
export function installConsoleScrub(): void {
  if (wrapped) return;
  wrapped = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args.map(scrubArgument));
    };
  }
}

function scrubArgument(argument: unknown): unknown {
  if (typeof argument === "string") return scrub(argument);
  if (argument instanceof Error) return scrub(argument.stack ?? String(argument));
  return argument;
}
