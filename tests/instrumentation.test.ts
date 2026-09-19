import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `instrumentation.ts` decides, not what Langfuse does with it: core's own
 * `langfuse.test.ts` asserts on the OTel global, and that registration is process-wide — a
 * second one here would leak into every other file in the run. So `registerLangfuse` is a spy,
 * and what is asserted is whether the web reaches for it at all, and how often.
 */
const registerLangfuse = vi.fn(() => ({ shutdown: () => Promise.resolve() }));

vi.mock("@hyperfixation/workflows", () => ({ registerLangfuse }));

const KEYS = {
  LANGFUSE_BASE_URL: "http://langfuse.invalid",
  LANGFUSE_PUBLIC_KEY: "pk-lf-fake",
  LANGFUSE_SECRET_KEY: "sk-lf-fake",
};

const MANAGED = ["NEXT_RUNTIME", ...Object.keys(KEYS)];
const saved = new Map<string, string | undefined>();

/**
 * Re-imported per test: whether it has already registered is module state, which is the whole
 * point of the "exactly once" case.
 */
async function freshRegister(): Promise<() => Promise<void>> {
  vi.resetModules();
  return (await import("../instrumentation")).register;
}

beforeEach(() => {
  for (const name of MANAGED) saved.set(name, process.env[name]);
  for (const name of Object.keys(KEYS)) process.env[name] = "";
  process.env.NEXT_RUNTIME = "nodejs";
  registerLangfuse.mockClear();
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
