import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REQUIRED_ENV } from "../src/env";

/**
 * Track B's done-check. The three deployed services have to agree with `REQUIRED_ENV` and with
 * each other, exactly — not "contain", not "a superset".
 *
 * An extra key is as much a failure as a missing one: a var in compose that no code reads is
 * either a var that was renamed in code and not here (the app reads an unset name in
 * production and nowhere else) or a leftover, and both look identical at a glance. The only
 * cheap way to tell them apart is to refuse to have either.
 */

const root = new URL("../", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, root)), "utf8");

interface ComposeService {
  environment?: Record<string, unknown>;
  mem_limit?: string;
  stop_grace_period?: string;
  command?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  restart?: string;
}

const prod = parse(read("docker-compose.prod.yml")) as { services: Record<string, ComposeService> };
const dev = parse(read("docker-compose.yml")) as { services: Record<string, ComposeService> };

const DEPLOYED_SERVICES = ["migrate", "web", "worker"] as const;

describe("docker-compose.prod.yml environment blocks", () => {
  it.each(DEPLOYED_SERVICES)("%s lists exactly REQUIRED_ENV", (name) => {
    const service = prod.services[name];
    expect(service, `docker-compose.prod.yml has no ${name} service`).toBeDefined();

    // Sorted rather than set-compared so a failure names the difference instead of reporting
    // that two sets of fourteen strings are unequal.
    expect(Object.keys(service?.environment ?? {}).sort()).toEqual([...REQUIRED_ENV].sort());
  });

  it("names each service's own HF_PROCESS", () => {
    for (const name of DEPLOYED_SERVICES) {
      expect(prod.services[name]?.environment?.HF_PROCESS).toBe(name);
    }
  });
});

describe("docker-compose.prod.yml deploy shape", () => {
  it("gives every service a memory limit", () => {
    expect(prod.services.web?.mem_limit).toBe("512m");
    expect(prod.services.worker?.mem_limit).toBe("768m");
    expect(prod.services.migrate?.mem_limit).toBe("256m");
  });

  /**
   * The drain is 60 s and the worker's own watchdog is 75 s; SIGKILL has to land after both or
   * it is not a last line of defence, it is the mechanism.
   */
  it("gives the worker a 90s stop_grace_period and no one else one", () => {
    expect(prod.services.worker?.stop_grace_period).toBe("90s");
    expect(prod.services.web?.stop_grace_period).toBeUndefined();
    expect(prod.services.migrate?.stop_grace_period).toBeUndefined();
  });

  it("holds web and worker behind a migrate that exited 0", () => {
    for (const name of ["web", "worker"] as const) {
      expect(prod.services[name]?.depends_on?.migrate?.condition).toBe(
        "service_completed_successfully",
      );
    }
    // A restarting one-shot would re-run the migrator behind the services waiting on it.
    expect(prod.services.migrate?.restart).toBe("no");
  });
});

describe("docker-compose.yml is development infrastructure only", () => {
  it("runs pgvector/pg17 and mailpit, and none of the app's services", () => {
    expect(Object.keys(dev.services).sort()).toEqual(["mailpit", "postgres"]);
    expect((dev.services.postgres as { image?: string }).image).toBe("pgvector/pgvector:pg17");
  });
});

describe(".env.example", () => {
  it("documents exactly REQUIRED_ENV", () => {
    const declared = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...REQUIRED_ENV].sort());
  });
});
