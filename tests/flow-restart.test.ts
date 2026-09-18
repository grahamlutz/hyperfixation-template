import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bumpAttempt, controlPlaneTx } from "@hyperfixation/db";
import { asRole, createTestDatabase, spawnWorker, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, recordTables } from "../src/hyperfixation";

/**
 * The app's own contract suite: every registered flow, run on its fixture, then **restarted**,
 * with the second attempt asserted to add nothing.
 *
 * The restart is the point. A run crosses a deploy only by restarting — `reconcile()` bumps
 * every run left `running` under the old version through the same path this test drives — so a
 * flow that is not idempotent across an attempt bump is a flow that double-charges, double-
 * sends, or double-writes on the first redeploy that happens to catch it mid-run. That is
 * invisible in a test that runs a flow once, which is why this one runs every flow twice.
 *
 * And because the worker is a real process under `HF_PROCESS=worker`, the step pool's
 * production fence rule is in force: any write a flow issues outside `ctx.tx` — from a timer,
 * a listener, a helper that imported the raw handle — is refused as `UnfencedWrite` here, in
 * the app's own suite, rather than in production. `spawnWorker` surfaces those as fencing
 * failures, and a flow that produces one fails below.
 */

const FIXTURES = new URL("../fixtures/", import.meta.url);
const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));

/** Every machinery table whose row count a restart must not change. */
const MACHINERY_TABLES = ["hf_llm_call", "hf_action_log", "hf_audit", "hf_approval"] as const;
/** Every app table the demo writes. Add a table here when a flow starts writing one. */
const APP_TABLES = ["demo_note"] as const;

const flows = app.flows.all();

function fixtureFor(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as unknown;
}

describe("flow-restart", () => {
  let database: TestDatabase;
  let pool: Pool;
  let client: DBOSClient;
  let worker: ReturnType<typeof spawnWorker>;

  beforeAll(async () => {
    database = await createTestDatabase({
      recordTables,
      appMigrationsDir: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });

    worker = spawnWorker({
      module: WORKER_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    await worker.ready();

    pool = new Pool({ connectionString: database.applicationUrl, max: 2 });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
    app.attach({ pool, client });
  }, 120_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await pool?.end();
    await worker?.kill().catch(() => undefined);
    await database?.drop();
  });

  it("registers a fixture for every flow", () => {
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) expect(() => fixtureFor(flow.name)).not.toThrow();
  });

  it.each(flows.map((flow) => [flow.name, flow] as const))(
    "%s adds nothing on a second attempt",
    async (name, flow) => {
      // A registry holds `Flow<never, unknown>` — the bottom of the family, because input is
      // contravariant — so iterating every flow and handing each one a `unknown` fixture needs
      // the widening spelled out. The fixture's shape is the flow's own contract, checked by
      // the flow at run time and by nothing here.
      const started = await app.runs.start(flow as unknown as Flow<unknown>, fixtureFor(name));
      await waitForStatus(started.runId, "done");
      const afterFirst = await counts();

      // Exactly what `reconcile()` and `decide()` do to a run a redeploy interrupted: one
      // transaction that takes `hf_run FOR UPDATE`, moves the fencing token on, and enqueues
      // the next attempt. Nothing about the flow knows it is the second time.
      const bumped = await controlPlaneTx(pool, { operation: "flow-restart" }, async (pg) => {
        const next = await bumpAttempt(pg, started.runId);
        await client.enqueueInTransaction(
          pg,
          { queueName: flow.queue, workflowName: flow.name, workflowID: next.workflowId },
          { runId: started.runId, attempt: next.attempt, input: next.input },
        );
        return next;
      });
      expect(bumped.attempt).toBe(2);

      await waitForWorkflow(bumped.workflowId, "done");
      expect(await counts()).toEqual(afterFirst);
      expect(worker.fencingFailures()).toEqual([]);
    },
    180_000,
  );

  async function counts(): Promise<Record<string, number>> {
    return asRole(database.applicationUrl, async (pg) => {
      const result: Record<string, number> = {};
      for (const table of [...MACHINERY_TABLES, ...APP_TABLES]) {
        const { rows } = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`);
        result[table] = Number(rows[0]?.n ?? 0);
      }
      return result;
    });
  }

  async function waitForStatus(runId: string, status: string, timeoutMs = 60_000): Promise<void> {
    await until(
      async () => (await scalar("SELECT status FROM hf_run WHERE run_id = $1", [runId])) === status,
      timeoutMs,
      () => `hf_run ${runId} never reached ${status}`,
    );
  }

  /**
   * Keyed on the fencing token rather than on the status: after a bump the row is `running`
   * again and settles back to `done`, so waiting on the status alone would match the first
   * attempt's `done` that is still there when the bump commits.
   */
  async function waitForWorkflow(workflowId: string, status: string, timeoutMs = 60_000) {
    await until(
      async () =>
        (await scalar(
          "SELECT status FROM hf_run WHERE current_workflow_id = $1 AND finished_at IS NOT NULL",
          [workflowId],
        )) === status,
      timeoutMs,
      () => `attempt ${workflowId} never finished ${status}`,
    );
  }

  async function scalar(sql: string, params: unknown[]): Promise<string | undefined> {
    const { rows } = await pool.query<Record<string, string>>(sql, params);
    return rows[0] === undefined ? undefined : Object.values(rows[0])[0];
  }
});

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`${describeFailure()} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
