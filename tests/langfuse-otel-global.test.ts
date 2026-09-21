import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * That the app's own Sentry leaves the OpenTelemetry trace global to Langfuse — the one thing
 * `instrumentation.test.ts` cannot say, because every init there is a spy.
 *
 * So this file initialises the real `@sentry/node` with the real options `src/sentry.ts` passes,
 * registers the real `registerLangfuse()`, and asserts on what a localhost OTLP server receives.
 * Both globals are process-wide and one-shot, which is why this is a file of its own — vitest gives
 * it a fork — why the no-op case runs before the registering one, and why the ordering matters.
 *
 * Nothing leaves the machine: the same fake server is Langfuse's endpoint and Sentry's, so the
 * error half is proven by an envelope arriving rather than by reading the option off the file.
 */

/** OpenTelemetry's own global slot. Read directly so this file needs no `@opentelemetry/api`. */
const OTEL_GLOBAL = Symbol.for("opentelemetry.js.api.1");

interface Received {
  url: string;
  authorization: string | undefined;
  publicKey: string | undefined;
  body: string;
}

interface GlobalTracerProvider {
  getTracer(name: string): {
    startSpan(name: string, options?: { attributes: Record<string, string> }): { end(): void };
  };
}

const received: Received[] = [];
let server: http.Server;
let origin: string;

const KEYS = { LANGFUSE_PUBLIC_KEY: "pk-lf-fake", LANGFUSE_SECRET_KEY: "sk-lf-fake" };
const MANAGED = ["SENTRY_DSN", "LANGFUSE_BASE_URL", ...Object.keys(KEYS)];
const saved = new Map<string, string | undefined>();

function otlp(): Received[] {
  return received.filter((request) => request.url.includes("/otel/"));
}

beforeAll(async () => {
  for (const name of MANAGED) saved.set(name, process.env[name]);

  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        publicKey: request.headers["x-langfuse-public-key"] as string | undefined,
        body: Buffer.concat(chunks).toString("latin1"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The app's own init, not a copy of its options: `http` and this host so the envelope is
  // received here instead of reaching the internet.
  process.env.SENTRY_DSN = `http://public@127.0.0.1:${(server.address() as AddressInfo).port}/1`;
  const { initSentry } = await import("../src/sentry");
  expect(await initSentry()).toBe(true);
});

afterAll(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Sentry beside Langfuse", () => {
  it("still reports an error with the OTel setup skipped", async () => {
    const Sentry = await import("@sentry/node");

    Sentry.captureException(new Error("otel-global boom"));
    await Sentry.flush(5_000);

    const envelopes = received.filter((request) => request.url.includes("/envelope/"));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.body).toContain("otel-global boom");
    // The handler that reports what nothing caught; skipping the OTel setup does not drop it.
    expect(Sentry.getClient()?.getIntegrationByName("OnUncaughtException")).toBeDefined();
  });

  it("exports nothing at all when the Langfuse keys are absent", async () => {
    for (const name of ["LANGFUSE_BASE_URL", ...Object.keys(KEYS)]) process.env[name] = "";

    const { registerLangfuse } = await import("@hyperfixation/workflows");

    expect(registerLangfuse()).toBeUndefined();
    expect(globalThis[OTEL_GLOBAL as never]).toBeUndefined();
    expect(otlp()).toEqual([]);
  });

  // After the case above, because `provider.register()` cannot be undone.
  it("lets Langfuse own the trace global, so a gen_ai span reaches it", async () => {
    Object.assign(process.env, KEYS, { LANGFUSE_BASE_URL: origin });

    const { registerLangfuse } = await import("@hyperfixation/workflows");
    const registration = registerLangfuse();
    expect(registration).toBeDefined();

    // Through the global tracer, which is how `llm.run` creates its spans, and with the attributes
    // `LangfuseSpanProcessor`'s default filter keeps.
    const provider = globalThis[OTEL_GLOBAL as never] as unknown as {
      trace: GlobalTracerProvider;
    };
    provider.trace
      .getTracer("langfuse-otel-global.test")
      .startSpan("chat", {
        attributes: { "gen_ai.operation.name": "chat", "gen_ai.system": "anthropic" },
      })
      .end();

    // The flush the worker's SIGTERM handler calls.
    await registration!.shutdown();

    expect(otlp()).toHaveLength(1);
    const [exported] = otlp();
    expect(exported!.url).toBe("/api/public/otel/v1/traces");
    expect(exported!.authorization).toBe(
      `Basic ${Buffer.from(`${KEYS.LANGFUSE_PUBLIC_KEY}:${KEYS.LANGFUSE_SECRET_KEY}`).toString("base64")}`,
    );
    expect(exported!.publicKey).toBe(KEYS.LANGFUSE_PUBLIC_KEY);
    expect(exported!.body).toContain("gen_ai.operation.name");
  });
});
