import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `instrumentation.ts` decides, not what Langfuse does with it: core's own
 * `langfuse.test.ts` asserts on the OTel global, and that registration is process-wide — a
 * second one here would leak into every other file in the run. So `registerLangfuse` is a spy,
 * and what is asserted is whether the web reaches for it at all, and how often.
 */
const registerLangfuse = vi.fn(() => ({ shutdown: () => Promise.resolve() }));

vi.mock("@hyperfixation/workflows", () => ({ registerLangfuse }));

/**
 * Sentry is a spy for the same reason and one more: a real `init()` installs process-wide
 * handlers and a transport. What is asserted is what a reviewer cannot read off the file — that
 * an empty DSN reaches for nothing at all, and that a DSN reaches for it once, with PII off.
 */
const webInit = vi.fn();
const workerInit = vi.fn();

vi.mock("@sentry/nextjs", () => ({ init: webInit, captureRequestError: vi.fn() }));
vi.mock("@sentry/node", () => ({ init: workerInit }));

/** Syntactically a DSN and nothing behind it; every assertion here is on the spy. */
const DSN = "https://public@o0.ingest.sentry.io/0";

const KEYS = {
  LANGFUSE_BASE_URL: "http://langfuse.invalid",
  LANGFUSE_PUBLIC_KEY: "pk-lf-fake",
  LANGFUSE_SECRET_KEY: "sk-lf-fake",
};

const MANAGED = ["NEXT_RUNTIME", "SENTRY_DSN", ...Object.keys(KEYS)];
const saved = new Map<string, string | undefined>();

/**
 * Re-imported per test: whether it has already registered is module state, which is the whole
 * point of the "exactly once" case.
 */
async function freshRegister(): Promise<() => Promise<void>> {
  vi.resetModules();
  return (await import("../instrumentation")).register;
}

/** The worker's half, and the same module state: `worker.ts` calls it through `boot-sentry`. */
async function freshInitSentry(): Promise<() => Promise<boolean>> {
  vi.resetModules();
  return (await import("../src/sentry")).initSentry;
}

beforeEach(() => {
  for (const name of MANAGED) saved.set(name, process.env[name]);
  for (const name of Object.keys(KEYS)) process.env[name] = "";
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.SENTRY_DSN = "";
  registerLangfuse.mockClear();
  webInit.mockClear();
  workerInit.mockClear();
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("instrumentation register()", () => {
  it("reaches for nothing when the keys are empty", async () => {
    await (await freshRegister())();

    expect(registerLangfuse).not.toHaveBeenCalled();
  });

  it("reaches for nothing when one of the three is empty", async () => {
    Object.assign(process.env, KEYS, { LANGFUSE_BASE_URL: "" });

    await (await freshRegister())();

    expect(registerLangfuse).not.toHaveBeenCalled();
  });

  it("registers exactly once when all three are set", async () => {
    Object.assign(process.env, KEYS);

    const register = await freshRegister();
    await register();
    await register();

    expect(registerLangfuse).toHaveBeenCalledTimes(1);
  });

  it("registers nothing off the node runtime", async () => {
    Object.assign(process.env, KEYS);
    process.env.NEXT_RUNTIME = "edge";

    await (await freshRegister())();

    expect(registerLangfuse).not.toHaveBeenCalled();
  });
});

describe("Sentry in the web", () => {
  it("does not initialise when the DSN is empty", async () => {
    await (await freshRegister())();

    expect(webInit).not.toHaveBeenCalled();
  });

  it("initialises once with PII off when the DSN is set", async () => {
    process.env.SENTRY_DSN = DSN;

    const register = await freshRegister();
    await register();
    await register();

    expect(webInit).toHaveBeenCalledTimes(1);
    expect(webInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: DSN, sendDefaultPii: false, tracesSampleRate: 0 }),
    );
  });

  it("does not initialise off the node runtime", async () => {
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_RUNTIME = "edge";

    await (await freshRegister())();

    expect(webInit).not.toHaveBeenCalled();
  });

  it("drops the integrations that would carry payloads", async () => {
    process.env.SENTRY_DSN = DSN;

    await (await freshRegister())();

    const { integrations } = webInit.mock.calls[0]![0] as {
      integrations: (defaults: { name: string }[]) => { name: string }[];
    };
    const kept = integrations([
      { name: "LocalVariables" },
      { name: "Console" },
      { name: "ProcessSession" },
      { name: "RequestData" },
      { name: "ContextLines" },
    ]).map((integration) => integration.name);

    // `RequestData` stays: `sendDefaultPii: false` is what empties it of bodies and PII.
    expect(kept).toEqual(["RequestData", "ContextLines"]);
  });
});

describe("Sentry in the worker", () => {
  it("does not initialise when the DSN is empty", async () => {
    expect(await (await freshInitSentry())()).toBe(false);
    expect(workerInit).not.toHaveBeenCalled();
  });

  it("initialises with PII off when the DSN is set", async () => {
    process.env.SENTRY_DSN = DSN;

    expect(await (await freshInitSentry())()).toBe(true);
    expect(workerInit).toHaveBeenCalledTimes(1);
    expect(workerInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: DSN, sendDefaultPii: false, tracesSampleRate: 0 }),
    );
  });
});
