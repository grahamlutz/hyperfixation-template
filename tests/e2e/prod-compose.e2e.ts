import { LAUNCHED_MARKER } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, startProdStack, type ProdStack } from "./prod-stack";

/**
 * D3's bar: the deployed stack comes up, and the four things only the deployed stack can be
 * asked are true of it.
 *
 * Everything else in `tests/` runs the app's code in this process or beside it. This runs the
 * image — three containers off one build, the migrator first as the migrator role, the web and
 * the worker as the application role under `USER node` — so what it proves is the composition:
 * that the roles are the ones each service needs, that the commit the build was given is the
 * one `/api/status` reports, that the worker launched DBOS at all, and that a redeploy's first
 * act, stopping the worker, is instant while nothing is in flight rather than 90 seconds.
 *
 * `pnpm test:prod`, never `pnpm test` or `pnpm test:e2e`: it wants Docker and a cluster the
 * containers can reach. See `tests/e2e/prod-stack.ts` for how that cluster is addressed.
 */

const docker = await dockerAvailable();
if (!docker) {
  console.warn("tests/e2e/prod-compose.e2e.ts skipped: `docker info` failed; is Docker running?");
}

describe.skipIf(!docker)("the prod compose stack", () => {
  let stack: ProdStack;

  beforeAll(async () => {
    stack = await startProdStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("ran the migrator to completion", async () => {
    expect(await stack.exitCodeOf("migrate")).toBe(0);
  });

  it("refuses /api/status without the read token", async () => {
    const response = await fetch(`${stack.baseUrl}/api/status`);
    expect(response.status).toBe(401);
  });

  it("serves /api/status under the read token, reporting the commit it was built with", async () => {
    const response = await fetch(`${stack.baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${stack.readToken}` },
    });
    expect(response.status).toBe(200);

    const report = (await response.json()) as { applicationVersion: string; app: string };
    expect(report.applicationVersion).toBe(stack.sourceCommit);
    expect(report.app).toBe(stack.appName);
  });

  it("launched DBOS in the worker", async () => {
    // Polled rather than read once: `web` answers as soon as it is listening, and the worker
    // takes the advisory lock and runs E001–E006 on its own clock.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const logs = await stack.logsOf("worker");
      if (logs.includes(LAUNCHED_MARKER)) return;
      if (Date.now() > deadline) {
        expect(logs, `worker never logged ${LAUNCHED_MARKER}`).toContain(LAUNCHED_MARKER);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  /**
   * Last, because it takes the worker down. `stop_grace_period: 90s` is the worker's ceiling
   * and not its cost: an idle worker's SIGTERM handler drains nothing, so a deploy that waited
   * anywhere near the grace period would mean the handler never ran and SIGKILL did the work.
   */
  it("stops an idle worker in under five seconds", async () => {
    const started = Date.now();
    await stack.compose(["stop", "worker"]);
    const elapsed = Date.now() - started;

    expect(await stack.exitCodeOf("worker")).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
  });
});
