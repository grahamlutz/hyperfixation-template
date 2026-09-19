import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/load-env";
import { startServer, type RunningServer } from "./server";

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
 * It needs the dev compose up and the app migrated and bootstrapped — `hf dev --compose-only &&
 * hf migrate && hf bootstrap` — and it starts the server itself. See `pnpm test:e2e`.
 *
 * The workspace suite at the bottom shares this file's browser, server and sign-in helpers: it is
 * the same signed-in member, one screen further in.
 */
const MEMBER_EMAIL = "member@example.com";
const ADMIN_EMAIL = "admin@example.com";
const DEMO_NOTE_NAME = "e2e archive target";
const BOARD_NOTE_NAME = "e2e board card";
const BOARD_ARCHIVED_NAME = "e2e board archived card";

let server: RunningServer;
let browser: Browser;
let pool: Pool;
let mailpit: string;

beforeAll(async () => {
  loadEnv(process.cwd());
  mailpit = mailpitUrl(required("SMTP_URL"));
  pool = new Pool({ connectionString: required("DATABASE_URL"), max: 2 });
  await seedMember();
  server = await startServer();
  browser = await chromium.launch();
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  await pool?.end();
});

describe("the Phase 1 exit bar", () => {
  it("signs a member in by emailed code, enrols a passkey, and 404s them on /admin", async () => {
    const { context, page } = await openWithAuthenticator();
    try {
      // A stranger is redirected rather than hidden from: the workspace has nothing to withhold
      // about its own existence, which is what makes the admin's 404 below a statement.
      await page.goto(`${server.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/sign-in");

      await signInByEmailedCode(page, MEMBER_EMAIL);
      // The emailed code is one factor, so it lands on step-up and nowhere else.
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      // Holding only the code, and not the role either: the admin 404s before the factor is
      // even reached, which is the policy's order and not an accident of this member's state.
      expect(await status(page, "/admin")).toBe(404);

      // The workspace refuses the code factor too, but by sending them to step up.
      await page.goto(`${server.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      await enrolPasskey(page);
      expect(new URL(page.url()).pathname).toBe("/w");
      await page.getByText(`Signed in as ${MEMBER_EMAIL}`).waitFor({ state: "visible" });

      // The session really was promoted, rather than the page having been reached some other way.
      expect(await factorOf(MEMBER_EMAIL)).toBe("passkey");
      expect(await passkeyCount(MEMBER_EMAIL)).toBe(1);

      // The whole point: a member who has done everything right still does not learn that an
      // admin exists at this path.
      expect(await status(page, "/admin")).toBe(404);
      expect(await status(page, "/admin/users")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);

  it("lets the bootstrapped admin, with a passkey, read the users table", async () => {
    const { context, page } = await openWithAuthenticator();
    try {
      await page.goto(`${server.baseUrl}/auth/sign-in`);
      await signInByEmailedCode(page, ADMIN_EMAIL);
      // An admin holding only an emailed code gets the member's 404, not a step-up: the role
      // test runs first precisely so the two are indistinguishable.
      expect(await status(page, "/admin")).toBe(404);

      await enrolPasskey(page);
      expect(new URL(page.url()).pathname).toBe("/w");

      await page.goto(`${server.baseUrl}/admin/users`);
      await page.getByRole("link", { name: ADMIN_EMAIL }).waitFor({ state: "visible" });
      await page.getByRole("link", { name: MEMBER_EMAIL }).waitFor({ state: "visible" });
      // The list's columns are the ones `usersResource` declares, labelled off the metadata.
      await page.getByRole("columnheader", { name: "Role" }).waitFor({ state: "visible" });

      await page.getByRole("link", { name: MEMBER_EMAIL }).click();
      await page.getByText("Ban reason").waitFor({ state: "visible" });

      // A resource the admin does not serve answers exactly as a refusal does.
      expect(await status(page, "/admin/widgets")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);
});

describe("the workspace", () => {
  it("shows the pipeline board with each record in its stage's column", async () => {
    const { context, page } = await openWithAuthenticator();
    const onBoard = await seedDemoNote(BOARD_NOTE_NAME, "scored");
    const archived = await seedDemoNote(BOARD_ARCHIVED_NAME, "scored");
    await pool.query(`UPDATE demo_note SET archived_at = now() WHERE id::text = $1`, [archived]);
    try {
      await signInByEmailedCode(page, MEMBER_EMAIL);
      await enrolPasskey(page);

      await page.goto(`${server.baseUrl}/w/demoNote`);
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
      await page.waitForURL(`${server.baseUrl}/w/demoNote/${onBoard}`);

      // `workspace.board` reads unarchived rows only, so the archived row is on no column.
      await page.goto(`${server.baseUrl}/w/demoNote`);
      expect(await page.getByRole("link", { name: BOARD_ARCHIVED_NAME }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 300_000);

  it("shows a member their home, a record's page, and archives it in one click", async () => {
    const { context, page } = await openWithAuthenticator();
    const recordId = await seedDemoNote();
    try {
      await signInByEmailedCode(page, MEMBER_EMAIL);
      await enrolPasskey(page);
      expect(new URL(page.url()).pathname).toBe("/w");

      // Home is the three things that need a human, whether or not any of them has rows yet.
      await page.getByRole("heading", { name: "Approvals" }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Open tasks" }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Review queue" }).waitFor({ state: "visible" });
      await page.getByText(`Signed in as ${MEMBER_EMAIL}`).waitFor({ state: "visible" });

      await page.goto(`${server.baseUrl}/w/demoNote/${recordId}`);
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
      expect(await status(page, "/w/demoNote/999999")).toBe(404);
      expect(await status(page, "/w/nothingRegistered")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);
});

describe("the approval inbox", () => {
  it("approves two real drafts in one batch, with one of them edited", async () => {
    const { context, page } = await openWithAuthenticator();
    const drafts = await twoPendingDrafts();
    const [edited, untouched] = [drafts.items[0]!, drafts.items[1]!];
    try {
      await signInByEmailedCode(page, MEMBER_EMAIL);
      await enrolPasskey(page);

      await page.goto(`${server.baseUrl}/w/approvals`);
      // Both drafts are here, each field in a box addressed to the approval it belongs to.
      for (const draft of drafts.items) {
        await subjectBox(page, draft.approvalId).waitFor({ state: "visible" });
      }

      // One approval on its own page — what the notifier's email links to: the same form with
      // one row and no checkbox to clear.
      await page.goto(`${server.baseUrl}/w/approvals/${edited.approvalId}`);
      await subjectBox(page, edited.approvalId).waitFor({ state: "visible" });
      expect(await page.locator('input[name="ids"][type="checkbox"]').count()).toBe(0);

      await page.goto(`${server.baseUrl}/w/approvals`);
      await subjectBox(page, edited.approvalId).fill(EDITED_SUBJECT);
      for (const draft of drafts.items) {
        await page.locator(`input[name="ids"][value="${draft.approvalId}"]`).check();
      }
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForURL(`${server.baseUrl}/w/approvals`);
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
      expect(await status(page, `/w/approvals/${edited.approvalId}`)).toBe(404);

      // And the decision carried the runs on: the attempt it enqueued sent the edited email and
      // left the follow-up task and the timeline row on the record's own page.
      await reloadUntil(page, `/w/demoNote/${edited.recordId}`, `Follow up with ${edited.name}`);
      await page.getByText("outreach.sent").waitFor({ state: "visible" });

      await page.getByRole("button", { name: "Label up" }).click();
      await page.getByText("up on record").waitFor({ state: "visible" });
    } finally {
      await drafts.stop();
      await context.close();
    }
  }, 600_000);
});

/**
 * A CTAP2 platform authenticator with a resident key and user verification already satisfied —
 * the shape a laptop's own biometric sensor presents. `automaticPresenceSimulation` is what
 * stands in for the touch nobody is there to give.
 */
async function openWithAuthenticator(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page };
}

async function signInByEmailedCode(page: Page, email: string): Promise<void> {
  await page.goto(`${server.baseUrl}/auth/sign-in`);
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await codeFromMailpit(email, since);
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${server.baseUrl}/auth/passkey`);
}

async function enrolPasskey(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/auth/passkey`);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.waitForURL(`${server.baseUrl}/w`, { timeout: 60_000 });
}

/** A plain fetch with the page's cookies, so a 404 is read as a status and not as a rendering. */
async function status(page: Page, path: string): Promise<number> {
  return page.evaluate(
    async (url: string) => (await fetch(url, { redirect: "manual" })).status,
    `${server.baseUrl}${path}`,
  );
}

/**
 * The code, out of mailpit's inbox. `since` is the instant the request was made: a second
 * sign-in for the same address would otherwise read the first attempt's code back.
 */
async function codeFromMailpit(email: string, since: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const search = new URL(`${mailpit}/api/v1/search`);
    search.searchParams.set("query", `to:${email}`);
    search.searchParams.set("limit", "5");
    const found = (await (await fetch(search)).json()) as {
      messages?: { ID: string; Created: string }[];
    };
    for (const message of found.messages ?? []) {
      if (Date.parse(message.Created) + 2_000 < since) continue;
      const body = (await (
        await fetch(`${mailpit}/api/v1/message/${message.ID}`)
      ).json()) as { Text?: string };
      const code = /\b\d{6}\b/.exec(body.Text ?? "")?.[0];
      if (code !== undefined) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in code reached ${email} within 30s; is mailpit up?`);
}

/** Seeded in SQL because there is no sign-up: a user exists because an admin put them there. */
async function seedMember(): Promise<void> {
  await pool.query(
    `INSERT INTO hf_user (id, name, email, email_verified, role)
     VALUES ($1, 'Demo Member', $2, true, 'member')
     ON CONFLICT (email) DO UPDATE SET role = 'member', banned = NULL`,
    [randomUUID(), MEMBER_EMAIL],
  );
  await pool.query(
    `DELETE FROM hf_session WHERE user_id IN (SELECT id FROM hf_user WHERE email = ANY($1::text[]))`,
    [[MEMBER_EMAIL, ADMIN_EMAIL]],
  );
  await pool.query(
    `DELETE FROM hf_passkey WHERE user_id IN (SELECT id FROM hf_user WHERE email = ANY($1::text[]))`,
    [[MEMBER_EMAIL, ADMIN_EMAIL]],
  );
}

/**
 * One record for the workspace to show, seeded rather than collected: the loop that produces
 * these is `tests/contract.test.ts`'s, on a database of its own, and what this suite needs is a
 * row with a name — not a run. The upsert un-archives it so the suite can be run twice.
 */
async function seedDemoNote(name = DEMO_NOTE_NAME, stage: string | null = null): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO demo_note (normalized_name, body, stage)
     VALUES ($1, 'A note the workspace suite archives.', $2)
     ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL, stage = EXCLUDED.stage
     RETURNING id::text AS id`,
    [name, stage],
  );
  await pool.query(`DELETE FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1`, [
    result.rows[0]!.id,
  ]);
  return result.rows[0]!.id;
}

async function archivedAt(recordId: string): Promise<Date | null> {
  const result = await pool.query<{ archived_at: Date | null }>(
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
  // evaluated, and `loadEnv` only fills the environment in `beforeAll`.
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
      pool,
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
  await pool.query("UPDATE demo_note SET archived_at = now() WHERE archived_at IS NULL");
  const recordIds: string[] = [];
  for (const note of INBOX_NOTES) {
    recordIds.push(await seedInboxNote(note.name, note.score));
    const started = await app.runs.start(flow.draftDemoOutreachFlow, {
      minScore: note.floor,
      limit: 1,
    });
    await waitForRunStatus(started.runId, "waiting");
  }

  // The two just written, newest first: a database this suite has already run against keeps
  // whatever a killed worker left waiting, and those rows are nobody's business here.
  const { rows } = await pool.query<{ id: number; record_id: string }>(
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

async function seedInboxNote(normalizedName: string, score: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version)
     VALUES ($1, 'Family roofing contractor, two vans, north side of the city.', $2, $3, 1)
     ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL, contact_email = $2,
       score = $3 RETURNING id::text AS id`,
    [normalizedName, "owner@acme-roofing.example", score],
  );
  const id = rows[0]!.id;
  await pool.query(`DELETE FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1`, [id]);
  return id;
}

async function waitForRunStatus(runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { rows } = await pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM hf_run WHERE run_id = $1",
      [runId],
    );
    if (rows[0]?.status === status) return;
    if (rows[0]?.status === "failed" || Date.now() > deadline) {
      throw new Error(`run ${runId} is ${rows[0]?.status}: ${rows[0]?.error ?? "no error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function subjectBox(page: Page, approvalId: number) {
  return page.locator(`[name="edit:${approvalId}:subject"]`);
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
  const { rows } = await pool.query<{
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

/** The run resumes on its own clock, so the page is asked again until its writes are there. */
async function reloadUntil(page: Page, path: string, text: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    await page.goto(`${server.baseUrl}${path}`);
    if ((await page.getByText(text).count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`"${text}" never appeared on ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function factorOf(email: string): Promise<string | undefined> {
  const result = await pool.query<{ factor: string }>(
    `SELECT s.factor FROM hf_session s JOIN hf_user u ON u.id = s.user_id
     WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [email],
  );
  return result.rows[0]?.factor;
}

async function passkeyCount(email: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM hf_passkey p JOIN hf_user u ON u.id = p.user_id
     WHERE u.email = $1`,
    [email],
  );
  return result.rows[0]?.count ?? 0;
}

/** mailpit's HTTP inbox is its SMTP port plus 7000, per `docker-compose.yml`. */
function mailpitUrl(smtpUrl: string): string {
  const url = new URL(smtpUrl);
  return `http://${url.hostname}:${Number(url.port || 1025) + 7000}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is unset; copy .env.example to .env and run hf migrate first`);
  }
  return value;
}
