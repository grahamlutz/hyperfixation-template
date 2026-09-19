import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { checkE002 } from "@hyperfixation/db";
import {
  createTestDatabase,
  runFlowSync,
  spawnWorker,
  type FlowSyncHarness,
  type TestDatabase,
} from "@hyperfixation/testing";
import { getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, recordTables } from "../src/hyperfixation";

/**
 * The demo loop, once, end to end, on nothing but the fixtures: collect → resolve → score →
 * draft → a human decides → the email goes out → a task and a timeline row.
 *
 * This is the suite that says the loop *works*. `flow-restart.test.ts` says every flow is
 * idempotent across an attempt bump, which four flows that each did nothing satisfy just as
 * well; `draft-approval.test.ts` says the far side of the gate behaves, but seeds its own
 * record rather than letting the earlier flows produce one. Only this file runs the chain the
 * way a deployed app does and asserts the rows it left.
 *
 * Nothing here has a provider key or a mail server. `src/llm.ts` falls back to `fixtures/llm/`
 * when no key at all is set, and `src/channels/email.ts` falls back to nodemailer's
 * `jsonTransport` when `SMTP_URL` is unset — the two conditions CI runs under. A key in the
 * environment would make this suite bill a real provider and send a real email, so under CI it
 * fails; on a developer's machine it skips with a warning.
 *
 * The restart is deliberately skipped: it is `flow-restart.test.ts`'s assertion over these same
 * four flows, and paying for it twice doubles the suite's runtime for nothing.
 */

const FIXTURES = new URL("../fixtures/", import.meta.url);
const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
const APP_TABLES = ["demo_note"] as const;

/** `runFlowSync`'s second attempt is `flow-restart.test.ts`'s job, not this file's. */
const ONCE = { restart: { skip: "flow-restart.test.ts asserts the restart over the same flows" } };

const flows = app.flows.all();

function fixtureFor(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as unknown;
}

// The two fallbacks this suite runs on: no provider key, no SMTP_URL. Outside CI a developer's
// exported key skips the suite, with a warning, rather than locking them out of `pnpm test`.
const leaked = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SMTP_URL"].filter(
  (name) => (process.env[name] ?? "") !== "",
);
const skipLocally = leaked.length > 0 && !process.env.CI;
if (skipLocally) {
  console.warn(
    `tests/contract.test.ts skipped: ${leaked.join(", ")} set; unset to run the demo loop on fixtures`,
  );
}

describe.skipIf(skipLocally)("the demo loop", () => {
  let database: TestDatabase;
  let pool: Pool;
  let client: DBOSClient;
  let worker: ReturnType<typeof spawnWorker>;
  let noteId: string;

  beforeAll(async () => {
    // In CI a leaked key must fail the suite, not skip it: the exit bar counts on this loop
    // running on fixtures there.
    if (leaked.length > 0) {
      throw new Error(
        `${leaked.join(", ")} set in CI. tests/contract.test.ts runs the whole loop on fixtures; ` +
          `a real provider or mail server would be billed and delivered to`,
      );
    }

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
    // What `hf bootstrap` seeds. The gate reserves a priced model's estimate before the call
    // settles at the fixture's zero, so without this row every `llm.run` is refused.
    await pool.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
    app.attach({ pool, client });

    await runLoop();
  }, 300_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await pool?.end();
    await worker?.kill().catch(() => undefined);
    await database?.drop();
  });

  it("staged both source rows and linked each to a record", async () => {
    const { rows } = await pool.query<{ external_id: string; status: string }>(
      "SELECT external_id, status FROM hf_source_record ORDER BY external_id",
    );
    expect(rows).toEqual([
      { external_id: "acme-roofing", status: "linked" },
      { external_id: "brightleaf-landscaping", status: "linked" },
    ]);

    const { rows: links } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM hf_record_link",
    );
    expect(links[0]?.count).toBe("2");
  });

  it("scored both records under the spec the scorer names", async () => {
    const { rows } = await pool.query<{
      normalized_name: string;
      score: number;
      spec_version: number;
      score_explanation: string;
    }>(
      "SELECT normalized_name, score, spec_version, score_explanation FROM demo_note " +
        "ORDER BY normalized_name",
    );
    expect(rows).toEqual([
      {
        normalized_name: "acme roofing",
        score: 0.82,
        spec_version: 1,
        score_explanation:
          "Owner-run, keeps its own premises, and the contact address is a named one.",
      },
      {
        normalized_name: "brightleaf landscaping",
        score: 0.21,
        spec_version: 1,
        score_explanation:
          "Reads as a directory listing with no named contact, and it subcontracts.",
      },
    ]);

    // `hf_score` carries `spec_version` but not the spec's name, so a record type with two specs
    // would need its own way to tell their rows apart. The demo has one.
    const { rows: scores } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM hf_score " +
        "WHERE record_type = 'demoNote' AND spec_version = 1",
    );
    expect(scores[0]?.count).toBe("2");
  });

  it("drafted, waited, and sent the approved draft on the email channel", async () => {
    const { rows: approvals } = await pool.query<{ type: string; status: string; record_id: string }>(
      "SELECT type, status, record_id FROM hf_approval",
    );
    // One gate, for the one record the scorer put above the flow's threshold.
    expect(approvals).toEqual([
      { type: "demoDraft", status: "approved", record_id: noteId },
    ]);

    const { rows: actions } = await pool.query<{
      channel: string;
      status: string;
      external_id: string | null;
      record_id: string | null;
      request: { to: string; subject: string };
    }>("SELECT channel, status, external_id, record_id, request FROM hf_action_log");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      channel: "email",
      status: "ok",
      record_id: noteId,
    });
    expect(actions[0]?.external_id).toBeTruthy();
    expect(actions[0]?.request.to).toBe("owner@acme-roofing.example");
    expect(actions[0]?.request.subject).toContain("north-side roofing");
  });

  it("opened the follow-up task and recorded the send", async () => {
    const tasks = await app.tasks.list({ recordType: "demoNote", recordId: noteId, open: true });
    expect(tasks.map((task) => task.title)).toEqual([
      "Follow up with acme roofing if there is no reply",
    ]);

    const timeline = await app.activity.list({ recordType: "demoNote", recordId: noteId });
    const sent = timeline.find((row) => row.kind === "outreach.sent");
    expect(sent?.body).toContain("north-side roofing");
  });

  /**
   * The one thing in the loop that no flow produces. A label is a human's feedback from the
   * record page, so it goes through the control plane rather than `ctx.tx`, and it writes its
   * own `label.added` timeline row alongside the `hf_label` one.
   */
  it("records a label added from the record page", async () => {
    const { id } = await app.labels.add({
      recordType: "demoNote",
      recordId: noteId,
      target: "score",
      value: "up",
      userId: "tester",
    });

    const labels = await app.labels.list({ recordType: "demoNote", recordId: noteId });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ id, target: "score", value: "up", userId: "tester" });

    const timeline = await app.activity.list({ recordType: "demoNote", recordId: noteId });
    expect(timeline.map((row) => row.kind)).toContain("label.added");
  });

  /**
   * E002 over everything the loop wrote. Every machinery table with a `record_type` column now
   * has rows in it — `hf_approval`, `hf_action_log`, `hf_activity`, `hf_task`, `hf_score`,
   * `hf_label` — so this is the boot check running against real data rather than an empty
   * database, which is the only way it can fail.
   */
  it("passes E002 with the demo record type registered", async () => {
    await expect(checkE002(pool, recordTables)).resolves.toBeUndefined();
    await expect(checkE002(pool, [])).rejects.toThrow("E002");
  });

  /**
   * Every provider call came from `fixtures/llm/`, and the countable proof is that nothing was
   * billed: the fixture model reports zero tokens, so each row settles at `cost_usd` 0 and the
   * period's `spent_usd` never moves off the zero the gate created it with. A real provider
   * cannot produce that — every one of them returns a token count.
   */
  it("billed nothing, because every call was served from fixtures", async () => {
    const { rows } = await pool.query<{
      key: string;
      status: string;
      model: string;
      tokens_in: number;
      tokens_out: number;
      cost_usd: string;
      possible_double_charge: boolean;
    }>(
      "SELECT key, status, model, tokens_in, tokens_out, cost_usd, possible_double_charge " +
        "FROM hf_llm_call ORDER BY key",
    );

    // Two scores and one draft: the brightleaf note scored below the draft flow's threshold, so
    // it was never drafted for. Both ids, because the second one is whichever the loop created.
    const { rows: notes } = await pool.query<{ id: string }>(
      "SELECT id::text AS id FROM demo_note ORDER BY id",
    );
    expect(rows.map((row) => row.key).sort()).toEqual(
      [`draft:${noteId}`, ...notes.map((note) => `score:${note.id}`)].sort(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "ok",
        model: "claude-haiku-4-5",
        tokens_in: 0,
        tokens_out: 0,
        possible_double_charge: false,
      });
      expect(Number(row.cost_usd)).toBe(0);
    }

    const { rows: periods } = await pool.query<{ spent_usd: string }>(
      "SELECT spent_usd FROM hf_budget_period",
    );
    expect(periods.map((row) => Number(row.spent_usd))).toEqual([0]);

    // The provider registry says so itself, once per process, on the worker that ran the calls.
    expect(worker.output()).toContain("serving LLM calls from fixtures");
  });

  /**
   * Runs the four flows in registration order — which is the loop's order — then decides the
   * approval the draft flow stopped at and waits for the run it resumes to finish.
   */
  async function runLoop(): Promise<void> {
    const harness: FlowSyncHarness = {
      pool,
      client,
      worker,
      // A registry holds `Flow<never, unknown>` — input is contravariant — so handing each flow
      // an `unknown` fixture needs the widening spelled out; the fixture's shape is the flow's
      // own contract, checked by the flow at run time and by nothing here.
      start: (flow, input) => app.runs.start(flow as Flow<unknown, unknown>, input),
      tables: APP_TABLES,
    };

    let draftRunId: string | undefined;
    for (const flow of flows) {
      const result = await runFlowSync(harness, flow, fixtureFor(flow.name), ONCE);
      if (result.status === "waiting") draftRunId = result.runId;
    }
    if (draftRunId === undefined) throw new Error("no flow stopped at an approval");

    const { rows } = await pool.query<{ id: number; record_id: string }>(
      "SELECT id::int AS id, record_id FROM hf_approval WHERE run_id = $1",
      [draftRunId],
    );
    noteId = rows[0]!.record_id;

    await app.approvals.decide({
      ids: [rows[0]!.id],
      decision: "approved",
      via: "web",
      decisionKey: randomUUID(),
      userId: "tester",
    });
    await waitForDone(draftRunId);
  }

  async function waitForDone(runId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { rows } = await pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM hf_run WHERE run_id = $1",
        [runId],
      );
      const row = rows[0]!;
      if (row.status === "done") return;
      if (row.status === "failed" || Date.now() > deadline) {
        throw new Error(`run ${runId} is ${row.status}: ${row.error ?? "no error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});
