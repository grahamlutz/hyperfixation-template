import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createTestDatabase, spawnWorker, type TestDatabase } from "@hyperfixation/testing";
import { ApprovalBatchRefused, getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONTACT_ALLOWLIST } from "../src/approvals/demo-draft";
import { draftDemoOutreachFlow } from "../src/flows/draft-demo-outreach";
import { app, recordTables } from "../src/hyperfixation";

/**
 * The draft flow's half that `flow-restart.test.ts` cannot reach: what happens **after** the
 * approval is decided.
 *
 * `flow-restart` runs every flow through an attempt bump and asserts the counts do not move, so
 * for this flow it only ever sees the suspended half — the run stops `waiting` at the gate and
 * re-suspends there. Everything past the gate is this file: the decision through the real
 * `app.approvals.decide`, the send on a channel that declares it cannot dedupe, the follow-up
 * task, the timeline row, and the two ways the app refuses rather than sends.
 *
 * With no provider key set the draft comes from `fixtures/llm/draft.json` and `SMTP_URL` is
 * unset, so the email channel serializes the message instead of delivering it. Nothing here
 * needs a key or a mail server.
 */

const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
const ALLOWLISTED = [...CONTACT_ALLOWLIST][0]!;

interface ApprovalRow {
  id: number;
  type: string;
  status: string;
  draft: { to: string; subject: string; body: string };
}

describe("draftDemoOutreach", () => {
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
    // The budget row `hf bootstrap` seeds. The gate reserves a priced model's estimate even
    // though a fixture answer settles at zero, so without this every `llm.run` is refused.
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

  /**
   * The flow picks the best-scoring unarchived record above the threshold, so each test archives
   * what the last one left rather than reasoning about which note sorts first.
   */
  beforeEach(async () => {
    await pool.query("UPDATE demo_note SET archived_at = now() WHERE archived_at IS NULL");
  });

  it("sends the approved draft, opens a follow-up task and records it", async () => {
    const noteId = await seedNote("acme roofing", ALLOWLISTED);
    const runId = await startAndWait("waiting");

    const approval = await approvalOf(runId);
    expect(approval.type).toBe("demoDraft");
    expect(approval.draft.to).toBe(ALLOWLISTED);
    // The fixture's own draft, which is what a human reads in the inbox.
    expect(approval.draft.subject).toContain("north-side roofing");

    const edited = { ...approval.draft, subject: "A question about your roofing work" };
    const decided = await app.approvals.decide({
      ids: [approval.id],
      decision: "approved",
      via: "web",
      decisionKey: randomUUID(),
      userId: "tester",
      edits: { [approval.id]: edited },
    });
    expect(decided.decided[0]?.status).toBe("approved");

    await waitForRun(runId, "done");

    const action = await actionOf(runId, `send:${noteId}`);
    expect(action).toMatchObject({ channel: "email", status: "ok", record_id: noteId });
    expect(action?.external_id).toBeTruthy();
    // The edit is what went out, not the draft the model proposed.
    expect((action?.request as { subject: string }).subject).toBe(edited.subject);

    const tasks = await app.tasks.list({ recordType: "demoNote", recordId: noteId, open: true });
    expect(tasks.map((task) => task.title)).toEqual([
      "Follow up with acme roofing if there is no reply",
    ]);

    const timeline = await app.activity.list({ recordType: "demoNote", recordId: noteId });
    expect(timeline.map((row) => row.kind)).toContain("outreach.sent");
  });

  it("refuses an edit that retargets the email outside the allowlist", async () => {
    const noteId = await seedNote("brightleaf landscaping", ALLOWLISTED);
    const runId = await startAndWait("waiting");
    const approval = await approvalOf(runId);

    const refused = app.approvals.decide({
      ids: [approval.id],
      decision: "approved",
      via: "web",
      decisionKey: randomUUID(),
      userId: "tester",
      edits: { [approval.id]: { ...approval.draft, to: "stranger@elsewhere.example" } },
    });
    await expect(refused).rejects.toThrow(ApprovalBatchRefused);
    // The reason, not just the class: a refusal for any other cause would pass the line above.
    await expect(refused).rejects.toThrow("not in the contact allowlist");

    // The whole batch rolled back: the row is still pending and nothing was sent.
    expect((await approvalOf(runId)).status).toBe("pending");
    expect(await actionOf(runId, `send:${noteId}`)).toBeUndefined();
  });

  /**
   * The non-deduping channel's whole point, driven the way it actually happens: an attempt that
   * is gone left a send in flight, and the attempt `decide()` enqueues re-enters `actions.perform`
   * over that row. SMTP cannot be asked whether the first message went out, so nothing is
   * re-sent — the row goes `uncertain`, a task asks a human, and the run fails.
   */
  it("surfaces ActionUncertain rather than sending a second time", async () => {
    const noteId = await seedNote("acme roofing", ALLOWLISTED);
    const runId = await startAndWait("waiting");
    const approval = await approvalOf(runId);
    await leaveSendInFlight(runId, `send:${noteId}`, noteId);

    await app.approvals.decide({
      ids: [approval.id],
      decision: "approved",
      via: "web",
      decisionKey: randomUUID(),
      userId: "tester",
    });

    const error = await waitForRun(runId, "failed");
    expect(error).toContain("ActionUncertain");

    const action = await actionOf(runId, `send:${noteId}`);
    expect(action?.status).toBe("uncertain");

    const tasks = await app.tasks.list({ recordType: "demoNote", recordId: noteId, open: true });
    expect(tasks.some((task) => task.title.startsWith("Confirm email send"))).toBe(true);
    const timeline = await app.activity.list({ recordType: "demoNote", recordId: noteId });
    expect(timeline.map((row) => row.kind)).toContain("action.uncertain");
  });

  async function seedNote(normalizedName: string, contactEmail: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version) " +
        "VALUES ($1, $2, $3, 0.82, 1) " +
        "ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL, contact_email = $3, " +
        "score = 0.82 RETURNING id",
      [normalizedName, "Family roofing contractor, two vans, works the north side of the city.", contactEmail],
    );
    return rows[0]!.id;
  }

  async function startAndWait(status: string): Promise<string> {
    const started = await app.runs.start(draftDemoOutreachFlow, { minScore: 0.5, limit: 1 });
    await waitForRun(started.runId, status);
    return started.runId;
  }

  /** Returns `hf_run.error`, which is the only place a failed run's reason survives. */
  async function waitForRun(runId: string, status: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { rows } = await pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM hf_run WHERE run_id = $1",
        [runId],
      );
      const row = rows[0]!;
      if (row.status === status) return row.error ?? "";
      if (row.status === "failed" || Date.now() > deadline) {
        throw new Error(`run ${runId} is ${row.status}, not ${status}: ${row.error ?? "no error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** `id` is cast in SQL: pg hands a `bigint` back as text, and `decide()` takes numbers. */
  async function approvalOf(runId: string): Promise<ApprovalRow> {
    const { rows } = await pool.query<ApprovalRow>(
      "SELECT id::int AS id, type, status, COALESCE(edited_draft, draft) AS draft " +
        "FROM hf_approval WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
      [runId],
    );
    return rows[0]!;
  }

  async function actionOf(
    runId: string,
    key: string,
  ): Promise<
    | {
        channel: string;
        status: string;
        external_id: string | null;
        record_id: string | null;
        request: unknown;
      }
    | undefined
  > {
    const { rows } = await pool.query<{
      channel: string;
      status: string;
      external_id: string | null;
      record_id: string | null;
      request: unknown;
    }>(
      "SELECT channel, status, external_id, record_id, request FROM hf_action_log " +
        "WHERE run_id = $1 AND key = $2",
      [runId, key],
    );
    return rows[0];
  }

  /**
   * What a killed attempt leaves behind: a `started` row nobody finished. Written by hand because
   * the only other way to produce one is to kill the worker mid-`send`, which is redeploy case 7's
   * job in core rather than this app's.
   */
  async function leaveSendInFlight(runId: string, key: string, noteId: string): Promise<void> {
    await pool.query(
      "INSERT INTO hf_action_log (run_id, key, workflow_id, channel, idempotency_key, status, " +
        "request, record_type, record_id) " +
        "VALUES ($1, $2, $3, 'email', $4, 'started', NULL, 'demoNote', $5)",
      [runId, key, `${runId}-gone`, `${runId}:${key}`, noteId],
    );
  }
});
