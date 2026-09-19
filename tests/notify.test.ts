import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import { createTestDatabase, spawnWorker, type TestDatabase } from "@hyperfixation/testing";
import {
  getClient,
  NO_RECIPIENTS_MARKER,
  resetClient,
  type ApprovalMessage,
  type ApprovalNotice,
  type StepContext,
} from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTACT_ALLOWLIST } from "../src/approvals/demo-draft";
import { draftDemoOutreachFlow } from "../src/flows/draft-demo-outreach";
import { app, recordTables } from "../src/hyperfixation";
import { approvalNotifier } from "../src/notify";

/**
 * The worker's approval notifier: who a gate the draft flow opened is told about, and what the
 * message says.
 *
 * The gate is the real one — `worker-fixture.ts` starts the worker with `src/notify.ts`'s
 * notifier exactly as `worker.ts` does, and the flow passes no `notify` of its own, so the run
 * that stops `waiting` has already been through it. What the spawned worker sent is not
 * readable from here (`SMTP_URL` is unset, so it serialized the message), so the message itself
 * is asserted by running the same notifier in this process over that approval, with a `send`
 * that captures instead of one that mails.
 */

const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
const ALLOWLISTED = [...CONTACT_ALLOWLIST][0]!;
const APP_URL = "https://workspace.test";
const ADMINS = ["ada@test.example", "grace@test.example"];
const ASSIGNEE = { id: "assignee-1", email: "hopper@test.example" };

// Read by the notifier in this process and by the one the spawned worker builds, which inherits
// this environment.
process.env.APP_URL = APP_URL;

interface ApprovalRow {
  id: number;
  type: string;
  draft: unknown;
  assignee_id: string | null;
  record_type: string | null;
  record_id: string | null;
  notified_at: Date | null;
}

describe("the approval notifier", () => {
  let database: TestDatabase;
  let pool: Pool;
  let steps: StepPool;
  let client: DBOSClient;
  let worker: ReturnType<typeof spawnWorker>;
  let runId: string;
  let approval: ApprovalRow;

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
    steps = createStepPool({ connectionString: database.applicationUrl });
    // The budget row `hf bootstrap` seeds; without it the draft's `llm.run` is refused.
    await pool.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
    app.attach({ pool, client });

    await seedUsers();
    await seedNote();
    const started = await app.runs.start(draftDemoOutreachFlow, { minScore: 0.5, limit: 1 });
    runId = started.runId;
    await waitForRun(runId, "waiting");
    approval = await approvalOf(runId);
  }, 180_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await steps?.end();
    await pool?.end();
    await worker?.kill().catch(() => undefined);
    await database?.drop();
  });

  it("notifies the admins once, with a link to the approval the flow opened", async () => {
    // The worker's own notifier ran and returned: the gate stamps this only afterwards, and it
    // warned about nobody to tell on the way.
    expect(approval.notified_at).not.toBeNull();
    expect(worker.output()).not.toContain(NO_RECIPIENTS_MARKER);

    const sent = await notify(noticeOf(approval));

    expect(sent).toHaveLength(1);
    // Every admin, and no member.
    expect(sent[0]!.to).toEqual(ADMINS);
    expect(sent[0]!.subject).toContain(approval.type);
    expect(sent[0]!.url).toBe(`${APP_URL}/w/approvals/${approval.id}`);
    // The link is in the body too: an email client shows the text, not the field.
    expect(sent[0]!.text).toContain(`${APP_URL}/w/approvals/${approval.id}`);
  });

  it("tells the assignee alone when the gate named one", async () => {
    const sent = await notify(noticeOf({ ...approval, assignee_id: ASSIGNEE.id }));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([ASSIGNEE.email]);
  });

  it("warns once and sends nothing when there is nobody to tell", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pool.query("UPDATE hf_user SET role = 'member' WHERE role = 'admin'");
    try {
      const sent = await notify(noticeOf(approval));

      expect(sent).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(NO_RECIPIENTS_MARKER);
    } finally {
      await pool.query("UPDATE hf_user SET role = 'admin' WHERE email = ANY($1::text[])", [ADMINS]);
      warn.mockRestore();
    }
  });

  /** The notifier `worker.ts` builds, with the send replaced by a capture. */
  async function notify(notice: ApprovalNotice): Promise<ApprovalMessage[]> {
    const sent: ApprovalMessage[] = [];
    const notifier = approvalNotifier(async (message) => {
      sent.push(message);
    });
    await notifier(notice, await context(runId));
    return sent;
  }

  function noticeOf(row: ApprovalRow): ApprovalNotice {
    return {
      approvalId: row.id,
      runId,
      key: "approve",
      type: row.type,
      draft: row.draft,
      assigneeId: row.assignee_id,
      recordType: row.record_type,
      recordId: row.record_id,
      expiresAt: null,
    };
  }

  /**
   * A step context over the run the gate belongs to, which is what the recipient read is fenced
   * by — the same `runId`/`workflowId` pair the worker's own notify step held.
   */
  async function context(forRun: string): Promise<StepContext> {
    const { rows } = await pool.query<{ current_workflow_id: string }>(
      "SELECT current_workflow_id FROM hf_run WHERE run_id = $1",
      [forRun],
    );
    const workflowId = rows[0]!.current_workflow_id;
    return {
      runId: forRun,
      attempt: 1,
      workflowId,
      key: "approval:notify",
      tx: (work) => steps.tx(forRun, workflowId, work),
    };
  }

  /** No sign-up: a user exists because an admin put them there, so the suite does. */
  async function seedUsers(): Promise<void> {
    const insert = "INSERT INTO hf_user (id, name, email, role) VALUES ($1, $2, $2, $3)";
    for (const email of ADMINS) await pool.query(insert, [email, email, "admin"]);
    await pool.query(insert, [ASSIGNEE.id, ASSIGNEE.email, "member"]);
  }

  async function seedNote(): Promise<void> {
    await pool.query(
      "INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version) " +
        "VALUES ('acme roofing', $1, $2, 0.82, 1)",
      ["Family roofing contractor, two vans, works the north side of the city.", ALLOWLISTED],
    );
  }

  async function waitForRun(forRun: string, status: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { rows } = await pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM hf_run WHERE run_id = $1",
        [forRun],
      );
      if (rows[0]?.status === status) return;
      if (rows[0]?.status === "failed" || Date.now() > deadline) {
        throw new Error(`run ${forRun} is ${rows[0]?.status}: ${rows[0]?.error ?? "no error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function approvalOf(forRun: string): Promise<ApprovalRow> {
    const { rows } = await pool.query<ApprovalRow>(
      "SELECT id::int AS id, type, draft, assignee_id, record_type, record_id, notified_at " +
        "FROM hf_approval WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
      [forRun],
    );
    return rows[0]!;
  }
});
