import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `src/scrub.ts` takes out of a string, and what it leaves alone.
 *
 * Every case re-imports the module: the secrets are collected once, at first use, so the
 * environment a case sets has to be the environment that collection sees.
 */

/** Shaped like the URL that reached the log on 2026-09-20; nothing behind it. */
const TOKEN = "cfut_oX0.p+q*r$s(t)u";
const SMTP_URL = `cloudflare-email://${encodeURIComponent(TOKEN)}@acct0123456789`;
const DATABASE_URL = "postgres://hf_app:pw-8chars@db.internal:5432/app";

/** The names these cases set themselves, and the copy of `src/scrub.ts`'s own pattern. */
const MANAGED = ["HF_BUILD_SHA", "SHORT_TOKEN", "EMPTY_SECRET"];
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|SMTP_URL|DATABASE_URL|_URL$)/i;

const saved = new Map<string, string | undefined>();

async function freshScrub(): Promise<typeof import("../src/scrub")> {
  vi.resetModules();
  return import("../src/scrub");
}

/**
 * Every secret-shaped name is unset for the duration, not only the ones set below: the suite's
 * own `HF_TEST_DATABASE_URL` holds `postgres` as a password on most machines, which would
 * redact the word out of half the strings asserted on here.
 */
beforeEach(() => {
  const names = [...MANAGED, ...Object.keys(process.env).filter((name) => SECRET_NAME.test(name))];
  for (const name of names) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("scrub()", () => {
  it("removes a token-bearing URL, and the token on its own", async () => {
    process.env.SMTP_URL = SMTP_URL;
    const { scrub } = await freshScrub();

    const message = `TypeError: Cannot create property 'mailer' on string '${SMTP_URL}'`;

    expect(scrub(message)).toBe(
      "TypeError: Cannot create property 'mailer' on string '[redacted:SMTP_URL]'",
    );
    // Percent-decoded too: the token is userinfo, and `src/email.ts` decodes it before use.
    expect(scrub(`token=${TOKEN}`)).toBe("token=[redacted:SMTP_URL]");
    expect(scrub(`token=${encodeURIComponent(TOKEN)}`)).toBe("token=[redacted:SMTP_URL]");
  });

  it("removes a connection string's password, whole URL or not", async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const { scrub } = await freshScrub();

    expect(scrub(`connect ${DATABASE_URL} failed`)).toBe(
      "connect [redacted:DATABASE_URL] failed",
    );
    expect(scrub("password authentication failed for pw-8chars")).toBe(
      "password authentication failed for [redacted:DATABASE_URL]",
    );
  });

  it("leaves the public names and anything too short alone", async () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.example.com";
    process.env.NEXT_PUBLIC_TOKEN = "public-token-value";
    process.env.HF_BUILD_SHA = "0123456789abcdef";
    process.env.SHORT_TOKEN = "short";
    process.env.EMPTY_SECRET = "";
    const { scrub } = await freshScrub();

    const text =
      "https://app.example.com https://langfuse.example.com public-token-value 0123456789abcdef short";

    expect(scrub(text)).toBe(text);
    // An empty value matches every string; a `[redacted:EMPTY_SECRET]` between each character
    // is the failure this asserts against.
    expect(scrub("nothing set here")).toBe("nothing set here");
  });

  it("changes nothing when no secret is set", async () => {
    const { scrub } = await freshScrub();

    expect(scrub(`connect ${DATABASE_URL} failed`)).toBe(`connect ${DATABASE_URL} failed`);
  });

  it("treats a secret's regex metacharacters as text", async () => {
    process.env.SMTP_URL = `smtp://user:a.b*c(d)$e[f]@mail.example.com`;
    const { scrub } = await freshScrub();

    expect(scrub("auth failed for a.b*c(d)$e[f]")).toBe("auth failed for [redacted:SMTP_URL]");
    // The pattern the secret would have been, had it been one: no match, so no redaction.
    expect(scrub("auth failed for aXbYcZdZeZfZ")).toBe("auth failed for aXbYcZdZeZfZ");
  });

  it("is idempotent", async () => {
    process.env.SMTP_URL = SMTP_URL;
    const { scrub } = await freshScrub();

    const once = scrub(`sending over ${SMTP_URL}`);

    expect(scrub(once)).toBe(once);
  });
});

describe("scrubEvent()", () => {
  it("scrubs a Sentry event's message, exceptions, frames and breadcrumbs", async () => {
    process.env.SMTP_URL = SMTP_URL;
    const { scrubEvent } = await freshScrub();

    const event = {
      message: `boot failed: ${SMTP_URL}`,
      exception: {
        values: [
          {
            type: "TypeError",
            value: `Cannot create property 'mailer' on string '${SMTP_URL}'`,
            stacktrace: {
              frames: [{ filename: "src/email.ts", vars: { url: SMTP_URL }, lineno: 91 }],
            },
          },
        ],
      },
      breadcrumbs: [{ message: `createTransport(${SMTP_URL})` }],
      contexts: { app: { smtp: TOKEN } },
      extra: { attempts: 2, urls: [SMTP_URL] },
    };

    const scrubbed = scrubEvent(event);

    expect(scrubbed).toBe(event);
    expect(JSON.stringify(scrubbed)).not.toContain("cfut_");
    expect(scrubbed.exception.values[0]!.value).toBe(
      "Cannot create property 'mailer' on string '[redacted:SMTP_URL]'",
    );
    expect(scrubbed.exception.values[0]!.stacktrace.frames[0]!.vars.url).toBe(
      "[redacted:SMTP_URL]",
    );
    expect(scrubbed.breadcrumbs[0]!.message).toBe("createTransport([redacted:SMTP_URL])");
    expect(scrubbed.contexts.app.smtp).toBe("[redacted:SMTP_URL]");
    expect(scrubbed.extra.urls[0]).toBe("[redacted:SMTP_URL]");
    // Non-strings are left as they are, not stringified on the way through.
    expect(scrubbed.extra.attempts).toBe(2);
    expect(scrubbed.exception.values[0]!.stacktrace.frames[0]!.lineno).toBe(91);
  });
});

describe("installConsoleScrub()", () => {
  const console_ = { error: console.error, warn: console.warn };

  afterEach(() => {
    console.error = console_.error;
    console.warn = console_.warn;
  });

  it("redacts a string argument and an Error, and wraps once", async () => {
    process.env.SMTP_URL = SMTP_URL;
    const { installConsoleScrub } = await freshScrub();

    const error = vi.fn();
    const warn = vi.fn();
    console.error = error;
    console.warn = warn;
    installConsoleScrub();
    const wrapper = console.error;
    installConsoleScrub();

    // A second wrap would nest, not double-print, so identity is the assertion.
    expect(console.error).toBe(wrapper);

    const thrown = new TypeError(`Cannot create property 'mailer' on string '${SMTP_URL}'`);
    console.error("hf-schedule: fire refused", "collectDemoSource", thrown);
    console.warn(`using ${SMTP_URL}`);

    const [prefix, name, printed] = error.mock.calls[0]!;
    expect([prefix, name]).toEqual(["hf-schedule: fire refused", "collectDemoSource"]);
    // The stack, as a string: the caller still holds the error it may rethrow, so nothing on it
    // is edited.
    expect(String(printed)).toContain("[redacted:SMTP_URL]");
    expect(String(printed)).not.toContain("cfut_");
    expect(thrown.message).toContain("cfut_");
    expect(warn.mock.calls[0]![0]).toBe("using [redacted:SMTP_URL]");
  });
});
