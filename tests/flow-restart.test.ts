import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  createTestDatabase,
  runFlowSync,
  spawnWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, recordTables } from "../src/hyperfixation";

/**
 * The app's own contract suite: every registered flow, run on its fixture, then **restarted**,
 * with the second attempt asserted to add nothing.
 *
 * The restart is the point. A run crosses a deploy only by restarting — `reconcile()` bumps
 * every run left `running` under the old version through the same path `runFlowSync` drives — so
 * a flow that is not idempotent across an attempt bump is a flow that double-charges, double-
 * sends, or double-writes on the first redeploy that happens to catch it mid-run. That is
 * invisible in a test that runs a flow once, which is why this one runs every flow twice.
 *
 * And because the worker is a real process under `HF_PROCESS=worker`, the step pool's production
 * fence rule is in force: any write a flow issues outside `ctx.tx` — from a timer, a listener, a
 * helper that imported the raw handle — is refused as `UnfencedWrite` here, in the app's own
 * suite, rather than in production. `runFlowSync` fails on one rather than waiting out a timeout.
 *
 * What it asserts is **row counts**, not values. A bumped attempt is a new workflow id, so every
 * step body genuinely re-runs; an upsert that increments a column keeps its row count while its
 * value moves. A flow that has to be value-idempotent needs its own assertion on top of this one.
 *
 * The flows run in the order `src/hyperfixation.ts` registers them, and that order is load-
 * bearing once the app's fixtures chain — a flow that collects rows has to run before the one
 * whose fixture expects to find them.
 */

const FIXTURES = new URL("../fixtures/", import.meta.url);
const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));

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
      const result = await runFlowSync(
        {
          pool,
          client,
          worker,
          // A registry holds `Flow<never, unknown>` — the bottom of the family, because input is
          // contravariant — so handing each flow an `unknown` fixture needs the widening spelled
          // out. The fixture's shape is the flow's own contract, checked by the flow at run time
          // and by nothing here.
          start: (f, input) => app.runs.start(f as Flow<unknown, unknown>, input),
          tables: APP_TABLES,
        },
        flow,
        fixtureFor(name),
      );

      // Both attempts settled at the same status, and a `waiting` flow re-suspended.
      expect(result.attempts).toBe(2);
    },
    180_000,
  );
});
