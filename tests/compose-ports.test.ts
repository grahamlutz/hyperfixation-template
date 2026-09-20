import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * A host port is one per box. `docker-compose.prod.yml` published `3000:3000`, so the second app
 * deployed on the Coolify box died at container start on `port is already allocated` — a fault
 * no amount of the app being correct could survive. Coolify's proxy routes to the container over
 * the Docker network and needs nothing published, so the deploy file publishes nothing at all.
 *
 * Every `ports:` entry publishes, including the short `"3000"` and a long entry with no
 * `published:` — both take an ephemeral host port. So the rule is the whole absence of `ports:`,
 * which is also the only form of it a reviewer can check at a glance.
 *
 * The suites that need to reach `web` from outside the stack layer
 * `tests/e2e/docker-compose.e2e-ports.yml` over this file instead.
 */

const root = new URL("../", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, root)), "utf8");

const prod = parse(read("docker-compose.prod.yml")) as {
  services: Record<string, { ports?: unknown; expose?: unknown }>;
};

describe("docker-compose.prod.yml publishes no host port", () => {
  it.each(Object.keys(prod.services))("%s has no ports:", (name) => {
    expect(prod.services[name]?.ports ?? []).toEqual([]);
  });

  it("exposes web's 3000 to the proxy instead", () => {
    expect(prod.services.web?.expose).toEqual(["3000"]);
  });
});

describe("tests/e2e/docker-compose.e2e-ports.yml", () => {
  const e2e = parse(read("tests/e2e/docker-compose.e2e-ports.yml")) as {
    services: Record<string, { ports?: string[] }>;
  };

  // Loopback and an interpolated port: a suite's published port is the test runner's business
  // and never reachable off the machine, which is what keeps it from being copied into a deploy.
  it("publishes web on the loopback, on the port prod-stack.ts picked", () => {
    expect(e2e.services.web?.ports).toEqual(["127.0.0.1:${HF_E2E_WEB_PORT}:3000"]);
  });
});
