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
 * bearing because the demo's fixtures chain: `collectDemoSource` stages the source's rows,
 * `resolveDemoSource` turns them into the `demo_note` records, those are what `scoreDemoNotes`
 * finds to score, and the scores are what `draftDemoOutreach` picks a record to write to by.
 * Nothing here resets the database between flows on purpose — the loop is what is under test,
 * not four flows in isolation.
 *
 * `draftDemoOutreach` settles `waiting` rather than `done`, which is a case worth naming: both
 * attempts stop at the same approval, and the second one must re-suspend on the row the first
 * one wrote instead of opening a second gate. What happens once that approval is decided is
 * `draft-approval.test.ts` — the restart harness never decides one.
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

    // What `hf bootstrap` seeds, and what `llm.run`'s gate needs: `hf_budget_period` is created
    // from `hf_app_state.budget_usd` by the month's first call, and there is nothing to copy
    // without this row. A fixture answer bills zero tokens, but the gate still *reserves* the
    // priced model's estimate before the call settles at 0 — so the budget has to cover the
    // estimate of every call a flow makes, not the nothing they end up costing.
    await pool.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
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

  /**
   * What the restart assertion cannot say. `runFlowSync` counts rows, so four flows that each
   * did nothing pass it just as well as four that ran the loop — and `scoreDemoNotes` in
   * particular is trivially stable if `resolveDemoSource` created no records for it to find.
   * This is the values half: the two fixture businesses became two records, and each one carries
   * the score `fixtures/llm/score.json` answers with under spec version 1.
   */
  it("left the demo loop's own rows behind", async () => {
    const { rows } = await pool.query<{
      normalized_name: string;
      score: number;
      spec_version: number;
    }>("SELECT normalized_name, score, spec_version FROM demo_note ORDER BY normalized_name");

    expect(rows).toEqual([
      { normalized_name: "acme roofing", score: 0.82, spec_version: 1 },
      { normalized_name: "brightleaf landscaping", score: 0.21, spec_version: 1 },
    ]);
  });

  /**
   * The same gap, for the flow that stops. `draftDemoOutreach` settling `waiting` twice is also
   * what a flow that selected nothing and suspended on nothing would look like from the counts,
   * so this names the row: one pending `demoDraft` for the record the scorer liked, and only one
   * after two attempts.
   */
  it("left one pending draft approval behind", async () => {
    const { rows } = await pool.query<{ type: string; status: string; record_id: string }>(
      "SELECT type, status, record_id FROM hf_approval",
    );

    const note = await pool.query<{ id: string }>(
      "SELECT id::text AS id FROM demo_note WHERE normalized_name = 'acme roofing'",
    );
    expect(rows).toEqual([
      { type: "demoDraft", status: "pending", record_id: note.rows[0]!.id },
    ]);
  });
});
