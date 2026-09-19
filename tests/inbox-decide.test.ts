import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { draftFields, type InboxItem, type WorkspaceDecideOptions } from "@hyperfixation/core/workspace";
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

/**
 * The same parser, over drafts no flow of this app produces — because `decide()` is handed
 * whatever an approval type's payload happens to be, and a `DraftField.path` is a description
 * of where a value came from rather than a key that can be trusted to lead back to it.
 *
 * No database: what is in question is which fields an edit may be taken from at all, and the
 * workspace is stubbed so that the call `decideFromForm` would make is the assertion.
 */
describe("the form's edits, over a hostile draft", () => {
  it("never walks into the prototype chain, and writes no edit for a path that names it", async () => {
    const item = itemFor({ "__proto__.polluted": "before" });
    const { deps, calls } = stub(item);
    const posted = form(item, { "__proto__.polluted": "PWNED" });

    const outcome = await decideFromForm(deps, posted);

    expect(outcome.error).toBeUndefined();
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    // The path resolves to nothing by own-property walking, so it is not an editable field and
    // the batch carries no edit at all.
    expect(calls[0]?.edits).toBeUndefined();
  });

  it("edits neither of two fields that flatten to the same path", async () => {
    const item = itemFor({ "a.b": "one", a: { b: "two" } });
    const { deps, calls } = stub(item);

    const outcome = await decideFromForm(deps, form(item, { "a.b": "typed" }));

    expect(outcome.error).toBeUndefined();
    expect(calls[0]?.edits).toBeUndefined();
  });

  it("takes an edit where the path is unique and leads to the value it was read from", async () => {
    const item = itemFor({ subject: "before", nested: { body: "keep" } });
    const { deps, calls } = stub(item);

    await decideFromForm(deps, form(item, { subject: "after" }));

    expect(calls[0]?.edits).toEqual({
      [item.approvalId]: { subject: "after", nested: { body: "keep" } },
    });
  });

  it("does not call a stored CRLF an edit, but still takes a real one", async () => {
    const item = itemFor({ body: "first\r\nsecond" });
    const { deps, calls } = stub(item);

    // What a text area posts back untouched: the same text, its breaks normalised by HTML.
    await decideFromForm(deps, form(item, { body: "first\r\nsecond" }));
    expect(calls[0]?.edits).toBeUndefined();

    await decideFromForm(deps, form(item, { body: "first\r\nthird" }));
    expect(calls[1]?.edits).toEqual({ [item.approvalId]: { body: "first\nthird" } });
  });

  function itemFor(draft: Record<string, unknown>): InboxItem {
    return {
      approvalId: 1,
      runId: "run-1",
      flow: "draftDemoOutreach",
      key: "approve:1",
      type: "demoDraft",
      recordType: "demoNote",
      recordId: "1",
      recordTitle: null,
      assigneeId: null,
      createdAt: new Date("2026-09-19T10:00:00Z"),
      expiresAt: null,
      draft,
      fields: draftFields(draft),
      editable: true,
    };
  }

  function stub(item: InboxItem): { deps: DecideDeps; calls: WorkspaceDecideOptions[] } {
    const calls: WorkspaceDecideOptions[] = [];
    return {
      calls,
      deps: {
        actor: ACTOR,
        workspace: {
          inbox: () => Promise.resolve({ items: [item], mine: 0, unassigned: 1 }),
          decide: (options) => {
            calls.push(options);
            return Promise.resolve({ replayed: false, decided: [], reattempted: [], batchId: null });
          },
        },
      },
    };
  }

  /** Every field posted back as the page would have rendered it, with these values replaced. */
  function form(item: InboxItem, typed: Record<string, string>): FormData {
    const formData = new FormData();
    formData.set("decision", "approved");
    formData.set("decisionKey", "stub-key");
    formData.append("ids", String(item.approvalId));
    for (const field of item.fields) {
      formData.set(editFieldName(item.approvalId, field.path), typed[field.path] ?? field.value);
    }
    return formData;
  }
});
