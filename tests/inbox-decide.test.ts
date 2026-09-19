import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { InboxItem } from "@hyperfixation/core/workspace";
import { createTestDatabase, spawnWorker, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decideFromForm,
  editFieldName,
  type DecideDeps,
} from "../app/(workspace)/w/[[...path]]/decide-form";
import { CONTACT_ALLOWLIST } from "../src/approvals/demo-draft";
import { draftDemoOutreachFlow } from "../src/flows/draft-demo-outreach";
import { app, recordTables } from "../src/hyperfixation";

/**
 * What the inbox's form does, over a real database and real approvals: the half of the page
 * that has no markup.
 *
 * The form is posted through `decideFromForm` rather than through the server action, because
 * the action is `workspaceRequest` plus `revalidatePath` plus a redirect and none of those are
 * what is in question. What is in question is that one submission is one `decide()` call — one
 * key, one batch, the edits attached to the rows they were typed on — and that a second post of
 * the same form replays rather than writing again.
 *
 * The approvals come from the real draft flow, the same way `draft-approval.test.ts` gets
 * them: two runs, each stopped at its own gate, because a run waits at the first approval it
 * asks for and a batch of two therefore needs two runs.
 */

const WORKER_MODULE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
const ALLOWLISTED = [...CONTACT_ALLOWLIST][0]!;
const ACTOR = { userId: "tester", admin: false };

describe("the inbox's decision", () => {
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

  beforeEach(async () => {
    await pool.query("UPDATE demo_note SET archived_at = now() WHERE archived_at IS NULL");
  });

  it("decides a batch of two in one call, with the edit on the row it was typed on", async () => {
    const [low, high] = await twoPendingApprovals();
    const subject = "A question about your roofing work";

    // The body is posted back with CRLF line breaks, which is what a browser does to a text
    // area nobody typed in; the untouched row below is what asserts that is not an edit.
    const posted = formFor([low, high], "approved", {
      [high.approvalId]: { subject },
      [low.approvalId]: { body: low.fields.find((f) => f.path === "body")!.value.replace(/\n/g, "\r\n") },
    });
    const first = await decideFromForm(deps(), posted);

    expect(first.error).toBeUndefined();
    expect(first.result?.replayed).toBe(false);
    expect(first.result?.decided.map((row) => row.approvalId).sort()).toEqual(
      [low.approvalId, high.approvalId].sort(),
    );
    // One submission, one batch: `decide()` stamps a batch id on a batch of more than one.
    expect(first.result?.batchId).not.toBeNull();

    const decided = await rowsOf([low.approvalId, high.approvalId]);
    expect(decided.map((row) => row.status)).toEqual(["approved", "approved"]);
    expect(new Set(decided.map((row) => row.batch_id)).size).toBe(1);
    expect(new Set(decided.map((row) => row.decision_key)).size).toBe(1);
    expect(decided.every((row) => row.decided_by === ACTOR.userId)).toBe(true);
    expect(decided.every((row) => row.decided_via === "web")).toBe(true);

    // The edit reached exactly one row, and the untouched one carries no edited draft at all:
    // a text box nobody typed in is not an edit, and must not be written back as one.
    const edited = decided.find((row) => row.id === high.approvalId);
    const untouched = decided.find((row) => row.id === low.approvalId);
    expect(edited?.edited_draft).toMatchObject({ subject, to: ALLOWLISTED });
    expect(untouched?.edited_draft).toBeNull();

    // The same form posted twice — a double click, a reloaded POST — replays: the decision key
    // is already on these rows, so nothing is written and what the first call did comes back.
    const second = await decideFromForm(deps(), posted);
    expect(second.error).toBeUndefined();
    expect(second.result?.replayed).toBe(true);
    const after = await rowsOf([low.approvalId, high.approvalId]);
    expect(after.map((row) => row.decided_at?.toISOString())).toEqual(
      decided.map((row) => row.decided_at?.toISOString()),
    );
    expect(after.map((row) => row.edited_draft)).toEqual(decided.map((row) => row.edited_draft));
  });

  it("surfaces the allowlist refusal as a sentence, and leaves the row pending", async () => {
    const [item] = await twoPendingApprovals();
    const posted = formFor([item], "approved", {
      [item.approvalId]: { to: "stranger@elsewhere.example" },
    });

    const outcome = await decideFromForm(deps(), posted);

    expect(outcome.error).toContain("not in the contact allowlist");
    expect(outcome.result).toBeUndefined();
    const [row] = await rowsOf([item.approvalId]);
    expect(row?.status).toBe("pending");
    expect(row?.decision_key).toBeNull();
  });

  it("refuses a row assigned to someone else when the session is not an admin", async () => {
    const [item] = await twoPendingApprovals();
    await pool.query("UPDATE hf_approval SET assignee_id = 'someone-else' WHERE id = $1", [
      item.approvalId,
    ]);

    // The id is posted even though this session's inbox no longer lists it: who may decide an
    // assigned row is `decide()`'s rule, inside the lock, and its refusal is the answer shown.
    const outcome = await decideFromForm(deps(), formFor([item], "approved"));

    expect(outcome.error).toContain(String(item.approvalId));
    expect((await rowsOf([item.approvalId]))[0]?.status).toBe("pending");
  });

  function deps(): DecideDeps {
    return { workspace: app.workspace, actor: ACTOR };
  }

  /**
   * Two runs, each waiting at its own gate. The flow takes the best-scoring unarchived record,
   * so the second note is seeded — and the second run's floor raised — after the first run has
   * already chosen: one run per record, without either of them reasoning about the other.
   */
  async function twoPendingApprovals(): Promise<[InboxItem, InboxItem]> {
    await seedNote("brightleaf landscaping", 0.7);
    await startAndWait(0.5);
    await seedNote("acme roofing", 0.9);
    await startAndWait(0.8);

    const { items } = await app.workspace.inbox({ userId: ACTOR.userId, admin: ACTOR.admin });
    const pending = items.slice(-2);
    expect(pending).toHaveLength(2);
    return [pending[0]!, pending[1]!];
  }

  /** The form the page would have posted: every field as the inbox flattened it, plus edits. */
  function formFor(
    items: readonly InboxItem[],
    decision: string,
    edits: Record<number, Record<string, string>> = {},
  ): FormData {
    const formData = new FormData();
    formData.set("decision", decision);
    formData.set("decisionKey", `key-${items.map((item) => item.approvalId).join("-")}`);
    formData.set("returnTo", "/w/approvals");
    for (const item of items) {
      formData.append("ids", String(item.approvalId));
      for (const field of item.fields) {
        const edit = edits[item.approvalId]?.[field.path];
        formData.set(editFieldName(item.approvalId, field.path), edit ?? field.value);
      }
    }
    return formData;
  }

  async function seedNote(normalizedName: string, score: number): Promise<void> {
    await pool.query(
      "INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version) " +
        "VALUES ($1, $2, $3, $4, 1) ON CONFLICT (normalized_name) DO UPDATE SET " +
        "archived_at = NULL, contact_email = $3, score = $4",
      [
        normalizedName,
        "Family roofing contractor, two vans, works the north side of the city.",
        ALLOWLISTED,
        score,
      ],
    );
  }

  async function startAndWait(minScore: number): Promise<void> {
    const started = await app.runs.start(draftDemoOutreachFlow, { minScore, limit: 1 });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { rows } = await pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM hf_run WHERE run_id = $1",
        [started.runId],
      );
      const row = rows[0]!;
      if (row.status === "waiting") return;
      if (row.status === "failed" || Date.now() > deadline) {
        throw new Error(`run ${started.runId} is ${row.status}: ${row.error ?? "no error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function rowsOf(ids: number[]): Promise<ApprovalRow[]> {
    const { rows } = await pool.query<ApprovalRow>(
      "SELECT id::int AS id, status, decision_key, batch_id, decided_at, decided_by, " +
        "decided_via, edited_draft FROM hf_approval WHERE id = ANY($1::bigint[]) ORDER BY id",
      [ids],
    );
    return rows;
  }
});

interface ApprovalRow {
  id: number;
  status: string;
  decision_key: string | null;
  batch_id: string | null;
  decided_at: Date | null;
  decided_by: string | null;
  decided_via: string | null;
  edited_draft: { to: string; subject: string; body: string } | null;
}
