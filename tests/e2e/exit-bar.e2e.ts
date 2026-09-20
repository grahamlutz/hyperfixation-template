import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_EMAIL,
  enrolPasskey,
  MEMBER_EMAIL,
  noticesFromMailpit,
  openWithAuthenticator,
  reloadUntil,
  required,
  signInByEmailedCode,
  startHarness,
  status,
  subjectBox,
  waitForRunStatus,
  type Harness,
} from "./harness";

/**
 * Phase 1's exit bar, driven end to end: sign in by emailed code, enrol a passkey through a
 * **software** authenticator, and get a 404 on `/admin` as a member.
 *
 * The passkey half is the reason this file exists at all. A WebAuthn ceremony needs an
 * authenticator, and until Chrome's DevTools `WebAuthn` domain there was no way to have one
 * without hardware — so "passkey enrolment through a software authenticator" was the one bullet
 * of chunk 14 that stayed manual. `WebAuthn.addVirtualAuthenticator` is a real CTAP2
 * authenticator inside the browser: the ceremony, the attestation and the credential are the
 * ones production runs, and only the hardware is simulated.
 *
 * It needs the dev compose up and the app migrated and bootstrapped — `hf up` once — and
 * `./harness.ts` starts the server itself. See `pnpm test:e2e`.
 *
 * The workspace suite at the bottom is the same signed-in member, one screen further in;
 * `demo-loop.e2e.ts` is Phase 2's bar over the same harness.
 */
const DEMO_NOTE_NAME = "e2e archive target";
const BOARD_NOTE_NAME = "e2e board card";
const BOARD_ARCHIVED_NAME = "e2e board archived card";
/** Long past, so the admin's edit cannot touch what any gate on this database reads. */
const BUDGET_PERIOD = "1999-01";

let harness: Harness;

/** The line the form prints, with `1.25` spent at any scale the ledger's column has. */
function spentOf(budget: string): RegExp {
  return new RegExp(`${BUDGET_PERIOD} — spent 1\\.2500(00)? of ${budget.replace(".", "\\.")}`);
}

async function budgetOf(period: string): Promise<string | undefined> {
  const { rows } = await harness.pool.query<{ budget: string }>(
    "SELECT budget_usd::text AS budget FROM hf_budget_period WHERE period = $1",
    [period],
  );
  return rows[0]?.budget;
}

beforeAll(async () => {
  harness = await startHarness();
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the Phase 1 exit bar", () => {
  it("signs a member in by emailed code, enrols a passkey, and 404s them on /admin", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    try {
      // A stranger is redirected rather than hidden from: the workspace has nothing to withhold
      // about its own existence, which is what makes the admin's 404 below a statement.
      await page.goto(`${harness.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/sign-in");

      await signInByEmailedCode(harness, page, MEMBER_EMAIL);
      // The emailed code is one factor, so it lands on step-up and nowhere else.
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      // Holding only the code, and not the role either: the admin 404s before the factor is
      // even reached, which is the policy's order and not an accident of this member's state.
      expect(await status(harness, page, "/admin")).toBe(404);

      // The workspace refuses the code factor too, but by sending them to step up.
      await page.goto(`${harness.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      await enrolPasskey(harness, page);
      expect(new URL(page.url()).pathname).toBe("/w");
      await page.getByText(`Signed in as ${MEMBER_EMAIL}`).waitFor({ state: "visible" });

      // The session really was promoted, rather than the page having been reached some other way.
      expect(await factorOf(MEMBER_EMAIL)).toBe("passkey");
      expect(await passkeyCount(MEMBER_EMAIL)).toBe(1);

      // The whole point: a member who has done everything right still does not learn that an
      // admin exists at this path.
      expect(await status(harness, page, "/admin")).toBe(404);
      expect(await status(harness, page, "/admin/users")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);

  it("lets the bootstrapped admin, with a passkey, read the users table", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    try {
      await page.goto(`${harness.baseUrl}/auth/sign-in`);
      await signInByEmailedCode(harness, page, ADMIN_EMAIL);
      // An admin holding only an emailed code gets the member's 404, not a step-up: the role
      // test runs first precisely so the two are indistinguishable.
      expect(await status(harness, page, "/admin")).toBe(404);

      await enrolPasskey(harness, page);
      expect(new URL(page.url()).pathname).toBe("/w");

      await page.goto(`${harness.baseUrl}/admin/users`);
      await page.getByRole("link", { name: ADMIN_EMAIL }).waitFor({ state: "visible" });
      await page.getByRole("link", { name: MEMBER_EMAIL }).waitFor({ state: "visible" });
      // The list's columns are the ones `usersResource` declares, labelled off the metadata.
      await page.getByRole("columnheader", { name: "Role" }).waitFor({ state: "visible" });

      await page.getByRole("link", { name: MEMBER_EMAIL }).click();
      await page.getByText("Ban reason").waitFor({ state: "visible" });

      // A resource the admin does not serve answers exactly as a refusal does.
      expect(await status(harness, page, "/admin/widgets")).toBe(404);

      // The one editable thing in the admin, over a period of its own: editing a live one would
      // change what the demo loop's gates may spend on this same database.
      await harness.pool.query(
        "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, '7', '1.25')",
        [BUDGET_PERIOD],
      );
      try {
        await page.goto(`${harness.baseUrl}/admin/budget-periods/${BUDGET_PERIOD}`);
        // `spent_usd` prints at whatever scale core's ledger stores it, so match the value
        // rather than a decimal count; `budget_usd` is this form's own and stays at four.
        await page.getByText(spentOf("7.0000")).waitFor();

        await page.getByLabel("Budget (USD)").fill("-1");
        await page.getByRole("button", { name: "Set budget" }).click();
        await page.getByRole("alert").waitFor();
        expect(await budgetOf(BUDGET_PERIOD)).toBe("7.0000");

        await page.getByLabel("Budget (USD)").fill("42.5");
        await page.getByRole("button", { name: "Set budget" }).click();
        await page.getByText(spentOf("42.5000")).waitFor();
        expect(await budgetOf(BUDGET_PERIOD)).toBe("42.5000");
      } finally {
        await harness.pool.query("DELETE FROM hf_budget_period WHERE period = $1", [BUDGET_PERIOD]);
      }
    } finally {
      await context.close();
    }
  }, 300_000);
});

describe("the workspace", () => {
  it("shows the pipeline board with each record in its stage's column", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    const onBoard = await seedDemoNote(BOARD_NOTE_NAME, "scored");
    const archived = await seedDemoNote(BOARD_ARCHIVED_NAME, "scored");
    await harness.pool.query(`UPDATE demo_note SET archived_at = now() WHERE id::text = $1`, [
      archived,
    ]);
    try {
      await signInByEmailedCode(harness, page, MEMBER_EMAIL);
      await enrolPasskey(harness, page);

      await page.goto(`${harness.baseUrl}/w/demoNote`);
      await page.getByRole("heading", { name: "Demo notes" }).waitFor({ state: "visible" });
      // The columns are the record type's `stages`, in the order it registered them.
      const columns = await page.getByRole("heading", { level: 2 }).allInnerTexts();
      // Each heading carries its column's count; the title is what is left without it.
      expect(columns.map((text) => text.replace(/\s*\d+\s*$/, "").trim())).toEqual([
        "New",
        "Scored",
        "Drafted",
        "Sent",
      ]);

      const scored = page.getByRole("heading", { name: /^Scored/ }).locator("xpath=..");
      await scored.getByRole("link", { name: BOARD_NOTE_NAME }).waitFor({ state: "visible" });
      await scored.getByRole("link", { name: BOARD_NOTE_NAME }).click();
      await page.waitForURL(`${harness.baseUrl}/w/demoNote/${onBoard}`);

      // `workspace.board` reads unarchived rows only, so the archived row is on no column.
      await page.goto(`${harness.baseUrl}/w/demoNote`);
      expect(await page.getByRole("link", { name: BOARD_ARCHIVED_NAME }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 300_000);

  it("shows a member their home, a record's page, and archives it in one click", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    const recordId = await seedDemoNote();
    try {
      await signInByEmailedCode(harness, page, MEMBER_EMAIL);
      await enrolPasskey(harness, page);
      expect(new URL(page.url()).pathname).toBe("/w");

      // Home is the three things that need a human, whether or not any of them has rows yet.
      await page.getByRole("heading", { name: "Approvals" }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Open tasks" }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Review queue" }).waitFor({ state: "visible" });
      await page.getByText(`Signed in as ${MEMBER_EMAIL}`).waitFor({ state: "visible" });

      await page.goto(`${harness.baseUrl}/w/demoNote/${recordId}`);
      await page.getByRole("heading", { name: DEMO_NOTE_NAME }).waitFor({ state: "visible" });

      await page.getByRole("button", { name: "Label up" }).click();
      await page.getByText("up on record").waitFor({ state: "visible" });

      await page.getByRole("button", { name: "Archive" }).click();
      // The page keeps showing the record; what changes is that it says so and stops offering
      // the button again. The `·` keeps this off the activity row the archive also wrote.
      await page.getByText(/· archived \d{4}-/).waitFor({ state: "visible" });
      expect(await page.getByRole("button", { name: "Archive" }).count()).toBe(0);
      // That row is the timeline's other half: what a human did carries no run, and the group
      // it lands in is the one this page calls "manual".
      await page.getByRole("heading", { name: "manual" }).waitFor({ state: "visible" });

      // And it has left the board's data: `workspace.board` reads unarchived rows only, so the
      // column this row was in no longer has it.
      expect(await archivedAt(recordId)).not.toBeNull();

      // A record type that is registered but has no such row is a 404, not an empty page.
      expect(await status(harness, page, "/w/demoNote/999999")).toBe(404);
      expect(await status(harness, page, "/w/nothingRegistered")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);
});

describe("the approval inbox", () => {
  it("approves two real drafts in one batch, with one of them edited", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    const drafts = await twoPendingDrafts();
    // The edited one is the higher-scoring note's, deliberately. A decision bumps the run's
    // attempt and the attempt runs the flow from the top, `select` included — so the run that
    // carries its own approval through to the send is the one whose record that select still
    // picks, which is the best-scoring unarchived row.
    const [untouched, edited] = [drafts.items[0]!, drafts.items[1]!];
    try {
      await signInByEmailedCode(harness, page, MEMBER_EMAIL);
      await enrolPasskey(harness, page);

      await page.goto(`${harness.baseUrl}/w/approvals`);
      // Both drafts are here, each field in a box addressed to the approval it belongs to.
      for (const draft of drafts.items) {
        await subjectBox(page, draft.approvalId).waitFor({ state: "visible" });
      }

      // One approval on its own page — what the notifier's email links to: the same form with
      // one row and no checkbox to clear.
      await page.goto(`${harness.baseUrl}/w/approvals/${edited.approvalId}`);
      await subjectBox(page, edited.approvalId).waitFor({ state: "visible" });
      expect(await page.locator('input[name="ids"][type="checkbox"]').count()).toBe(0);

      await page.goto(`${harness.baseUrl}/w/approvals`);
      await subjectBox(page, edited.approvalId).fill(EDITED_SUBJECT);
      for (const draft of drafts.items) {
        await page.locator(`input[name="ids"][value="${draft.approvalId}"]`).check();
      }
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForURL(`${harness.baseUrl}/w/approvals`);
      // Both have left the inbox: the boxes that edited them are not on the page any more.
      for (const draft of drafts.items) {
        await subjectBox(page, draft.approvalId).waitFor({ state: "detached" });
      }

      // One submission was one `decide()`: one batch id over both rows, one decision key, and
      // the edit written to the row it was typed on and to no other.
      const rows = await approvalRows([edited.approvalId, untouched.approvalId]);
      expect(rows.map((row) => row.status)).toEqual(["approved", "approved"]);
      expect(new Set(rows.map((row) => row.batch_id)).size).toBe(1);
      expect(new Set(rows.map((row) => row.decision_key)).size).toBe(1);
      expect(rows.find((row) => row.id === edited.approvalId)?.edited_draft?.subject).toBe(
        EDITED_SUBJECT,
      );
      expect(rows.find((row) => row.id === untouched.approvalId)?.edited_draft).toBeNull();
      // A decided row is no longer in anyone's inbox, so its own page answers as an unknown id.
      expect(await status(harness, page, `/w/approvals/${edited.approvalId}`)).toBe(404);

      // And the decision carried the runs on: the attempt it enqueued sent the edited email and
      // left the follow-up task and the timeline row on the record's own page.
      await reloadUntil(
        harness,
        page,
        `/w/demoNote/${edited.recordId}`,
        `Follow up with ${edited.name}`,
      );
      await page.getByText("outreach.sent").first().waitFor({ state: "visible" });
      // What went out is what was typed into the box, not what the model proposed.
      await page.getByText(EDITED_SUBJECT).first().waitFor({ state: "visible" });

      await page.getByRole("button", { name: "Label up" }).click();
      await page.getByText("up on record").first().waitFor({ state: "visible" });
    } finally {
      await drafts.stop();
      await context.close();
    }
  }, 600_000);
});

describe("the approval notifier", () => {
  it("emails the admin a link that opens the approval", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    const drafts = await twoPendingDrafts();
    const opened = drafts.items[0]!;
    const link = `${harness.baseUrl}/w/approvals/${opened.approvalId}`;
    try {
      // The gate named no assignee, so the recipients are the admins — the bootstrapped one is
      // the only row with that role — and the message is `src/notify.ts`'s, sent by the worker
      // through the same mailpit the sign-in codes go to.
      const messages = await noticesFromMailpit(harness, ADMIN_EMAIL, link);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toContain("demoDraft");

      // Followed by the human it was addressed to, the link is the one approval's page.
      await signInByEmailedCode(harness, page, ADMIN_EMAIL);
      await enrolPasskey(harness, page);
      await page.goto(link);
      await page.getByRole("heading", { level: 1, name: "demoDraft" }).waitFor({
        state: "visible",
      });
      await subjectBox(page, opened.approvalId).waitFor({ state: "visible" });
    } finally {
      await drafts.stop();
      await context.close();
    }
  }, 600_000);
});

/**
 * One record for the workspace to show, seeded rather than collected: the loop that produces
 * these is `tests/contract.test.ts`'s, on a database of its own, and what this suite needs is a
 * row with a name — not a run. The upsert un-archives it so the suite can be run twice.
 */
async function seedDemoNote(name = DEMO_NOTE_NAME, stage: string | null = null): Promise<string> {
  const result = await harness.pool.query<{ id: string }>(
    `INSERT INTO demo_note (normalized_name, body, stage)
     VALUES ($1, 'A note the workspace suite archives.', $2)
     ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL, stage = EXCLUDED.stage
     RETURNING id::text AS id`,
    [name, stage],
  );
  await harness.pool.query(
    `DELETE FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1`,
    [result.rows[0]!.id],
  );
  return result.rows[0]!.id;
}

async function archivedAt(recordId: string): Promise<Date | null> {
  const result = await harness.pool.query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM demo_note WHERE id::text = $1`,
    [recordId],
  );
  return result.rows[0]?.archived_at ?? null;
}

/** What the inbox suite types into the draft it edits. No URL, no phone, under the cap. */
const EDITED_SUBJECT = "A question about your roofing work";

/**
 * Two notes, worth one run each. A run waits at the first approval it asks for, so a batch of
 * two needs two runs — and the flow takes the best-scoring unarchived record, so the second
 * note is seeded, and the second run's floor raised, after the first run has already chosen.
 */
const INBOX_NOTES = [
  { name: "e2e inbox second", score: 0.71, floor: 0.5 },
  { name: "e2e inbox first", score: 0.91, floor: 0.8 },
];

interface DraftUnderTest {
  approvalId: number;
  recordId: string;
  name: string;
}

/**
 * Two real drafts, waiting at two real gates, with a worker up to carry the runs on once the
 * browser decides them.
 *
 * The drafts are the draft flow's own — `fixtures/llm/draft.json` through `demoDraftSchema` —
 * and not SQL: what the inbox posts is parsed against that schema inside `decide()`, and a
 * hand-written row would prove the form works against a draft nothing produced.
 *
 * The worker is `tests/worker-fixture.ts` rather than `worker.ts` because that one starts no
 * schedule tick, and it runs on the web server's own `HF_BUILD_SHA`: the attempt `decide()`
 * enqueues is dispatched by application version, so a worker on another one would leave both
 * runs exactly where they are.
 */
async function twoPendingDrafts(): Promise<{ items: DraftUnderTest[]; stop(): Promise<void> }> {
  // Imported here and not at the top: `defineApp()` reads `HF_BUILD_SHA` when the module is
  // evaluated, and the harness only fills the environment in `beforeAll`.
  const [{ app, recordTables }, flow, workflows, testing] = await Promise.all([
    import("../../src/hyperfixation"),
    import("../../src/flows/draft-demo-outreach"),
    import("@hyperfixation/workflows"),
    import("@hyperfixation/testing"),
  ]);

  const databaseUrl = required("DATABASE_URL");
  const worker = testing.spawnWorker({
    module: fileURLToPath(new URL("../worker-fixture.ts", import.meta.url)),
    appName: app.name,
    databaseUrl,
    version: required("HF_BUILD_SHA"),
  });
  await worker.ready();
  try {
    app.attach({
      pool: harness.pool,
      client: await workflows.getClient({ appName: app.name, databaseUrl, recordTables }),
    });
    return await pendingDrafts(app, flow, workflows, worker);
  } catch (error) {
    // Whatever went wrong, the worker holds this app's advisory lock until it dies, and the
    // next run of this suite cannot start one while it does.
    await worker.kill().catch(() => undefined);
    throw error;
  }
}

async function pendingDrafts(
  app: typeof import("../../src/hyperfixation").app,
  flow: typeof import("../../src/flows/draft-demo-outreach"),
  workflows: typeof import("@hyperfixation/workflows"),
  worker: ReturnType<typeof import("@hyperfixation/testing").spawnWorker>,
): Promise<{ items: DraftUnderTest[]; stop(): Promise<void> }> {
  await harness.pool.query("UPDATE demo_note SET archived_at = now() WHERE archived_at IS NULL");
  const recordIds: string[] = [];
  for (const note of INBOX_NOTES) {
    recordIds.push(await seedInboxNote(note.name, note.score));
    const started = await app.runs.start(flow.draftDemoOutreachFlow, {
      minScore: note.floor,
      limit: 1,
    });
    await waitForRunStatus(harness, started.runId, "waiting");
  }

  // The two just written, newest first: a database this suite has already run against keeps
  // whatever a killed worker left waiting, and those rows are nobody's business here.
  const { rows } = await harness.pool.query<{ id: number; record_id: string }>(
    `SELECT id::int AS id, record_id FROM hf_approval
     WHERE status = 'pending' AND record_id = ANY($1::text[]) ORDER BY id DESC LIMIT 2`,
    [recordIds],
  );
  expect(rows).toHaveLength(2);
  rows.sort((left, right) => left.id - right.id);
  const names = new Map(recordIds.map((id, index) => [id, INBOX_NOTES[index]!.name]));

  return {
    items: rows.map((row) => ({
      approvalId: row.id,
      recordId: row.record_id,
      name: names.get(row.record_id)!,
    })),
    stop: async () => {
      app.detach();
      await workflows.resetClient();
      await worker.kill().catch(() => undefined);
    },
  };
}

/** `stage` is a registered one, so these rows add no column to the board suite above. */
async function seedInboxNote(normalizedName: string, score: number): Promise<string> {
  const { rows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version, stage)
     VALUES ($1, 'Family roofing contractor, two vans, north side of the city.', $2, $3, 1,
       'scored')
     ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL, contact_email = $2,
       score = $3, stage = 'scored' RETURNING id::text AS id`,
    [normalizedName, "owner@acme-roofing.example", score],
  );
  const id = rows[0]!.id;
  await harness.pool.query(
    `DELETE FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1`,
    [id],
  );
  return id;
}

async function approvalRows(ids: number[]): Promise<
  {
    id: number;
    status: string;
    batch_id: string | null;
    decision_key: string | null;
    edited_draft: { subject: string } | null;
  }[]
> {
  const { rows } = await harness.pool.query<{
    id: number;
    status: string;
    batch_id: string | null;
    decision_key: string | null;
    edited_draft: { subject: string } | null;
  }>(
    `SELECT id::int AS id, status, batch_id, decision_key, edited_draft FROM hf_approval
     WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  return rows;
}

async function factorOf(email: string): Promise<string | undefined> {
  const result = await harness.pool.query<{ factor: string }>(
    `SELECT s.factor FROM hf_session s JOIN hf_user u ON u.id = s.user_id
     WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [email],
  );
  return result.rows[0]?.factor;
}

async function passkeyCount(email: string): Promise<number> {
  const result = await harness.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM hf_passkey p JOIN hf_user u ON u.id = p.user_id
     WHERE u.email = $1`,
    [email],
  );
  return result.rows[0]?.count ?? 0;
}
