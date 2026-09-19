import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashStatusToken } from "@hyperfixation/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_EMAIL,
  noticesFromMailpit,
  openWithAuthenticator,
  required,
  signInAsMember,
  startHarness,
  subjectBox,
  subjectsFromMailpit,
  waitForRunStatus,
  type Harness,
} from "./harness";

/**
 * Phase 2's exit bar, driven end to end through the app rather than through a harness: the demo
 * loop runs, a human approves two drafts with one edit from the real inbox, both emails reach
 * mailpit, the follow-up task and the label are on the record page — and then a pause parks the
 * next flow at its next step and a resume finishes it without a provider call.
 *
 * It is the same assertions as `redeploy-case-4.test.ts` in core, with every lever a deploy
 * actually has: `POST /api/status/pause` under the write token instead of `app.pause()`, and a
 * browser on `/w/approvals` instead of `approvals.decide()`. That is the whole reason it exists
 * beside `tests/contract.test.ts`, which runs the same loop with no server and no browser.
 *
 * It needs what `exit-bar.e2e.ts` needs — `hf up` once — and shares that file's harness. The
 * provider is the fixture provider, because the app's `.env` sets no key: an exit bar that
 * counted provider calls against a real one could not be run twice.
 */

/** The two records the demo source collects. Nothing else may be unarchived while this runs. */
const LOOP_RECORDS = ["acme roofing", "brightleaf landscaping"] as const;
const ACME = LOOP_RECORDS[0];
const ACME_CONTACT = "owner@acme-roofing.example";

/** What `fixtures/llm/draft.json` proposes for the acme note, and what a human types instead. */
const FIXTURE_SUBJECT = "A question about your north-side roofing work";
const EDITED_SUBJECT = "A question about your north-side crews";

interface Runtime {
  app: typeof import("../../src/hyperfixation").app;
  workflows: typeof import("@hyperfixation/workflows");
  worker: ReturnType<typeof import("@hyperfixation/testing").spawnWorker>;
  flows: {
    collect: import("@hyperfixation/workflows").Flow<unknown, unknown>;
    resolve: import("@hyperfixation/workflows").Flow<unknown, unknown>;
    score: import("@hyperfixation/workflows").Flow<unknown, unknown>;
    draft: import("@hyperfixation/workflows").Flow<unknown, unknown>;
  };
  inputs: { collect: unknown; resolve: unknown; score: unknown };
}

interface Draft {
  approvalId: number;
  recordId: string;
  subject: string;
}

let harness: Harness;
let runtime: Runtime;
let acmeId: string;
let drafts: Draft[];
/** The instant the batch was submitted; what tells this run's mail from an earlier run's. */
let decidedAt: number;

beforeAll(async () => {
  harness = await startHarness();
  runtime = await bringUpWorker();
  await onlyTheLoopsRecords();
}, 600_000);

afterAll(async () => {
  await leaveTheDatabaseAsItWasFound();
  runtime?.app.detach();
  await runtime?.workflows.resetClient();
  await runtime?.worker.kill().catch(() => undefined);
  await harness?.stop();
});

describe("the demo loop", () => {
  it("collects, resolves and scores the source, then stops at two drafts for a human", async () => {
    const { app, flows, inputs } = runtime;
    for (const [flow, input] of [
      [flows.collect, inputs.collect],
      [flows.resolve, inputs.resolve],
      [flows.score, inputs.score],
    ] as const) {
      const started = await app.runs.start(flow, input);
      await waitForRunStatus(harness, started.runId, "done");
    }

    const { rows: staged } = await harness.pool.query<{ external_id: string; status: string }>(
      "SELECT external_id, status FROM hf_source_record ORDER BY external_id",
    );
    expect(staged).toEqual([
      { external_id: "acme-roofing", status: "linked" },
      { external_id: "brightleaf-landscaping", status: "linked" },
    ]);

    // The scores the fixtures give, which are what the draft flow's floor is chosen against.
    const { rows: scored } = await harness.pool.query<{ name: string; score: number; id: string }>(
      `SELECT normalized_name AS name, score, id::text AS id FROM demo_note
       WHERE archived_at IS NULL ORDER BY normalized_name`,
    );
    expect(scored.map((row) => [row.name, row.score])).toEqual([
      ["acme roofing", 0.82],
      ["brightleaf landscaping", 0.21],
    ]);
    acmeId = scored.find((row) => row.name === ACME)!.id;

    // Two runs, because a run stops at the *first* gate it asks for: a batch of two needs two.
    // Both draft for the same record, and that is the flow's own arithmetic rather than a
    // shortcut — its select takes the best-scoring unarchived row, and the attempt a decision
    // enqueues re-runs that select, so the record the run carries through to its send is that
    // same one. Two runs over one record is exactly why the flow has no schedule.
    const runIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const started = await app.runs.start(flows.draft, { minScore: 0.2, limit: 1 });
      await waitForRunStatus(harness, started.runId, "waiting");
      runIds.push(started.runId);
    }

    const { rows } = await harness.pool.query<{
      id: number;
      record_id: string;
      draft: { subject: string };
    }>(
      `SELECT id::int AS id, record_id, draft FROM hf_approval
       WHERE run_id = ANY($1::text[]) AND status = 'pending' ORDER BY id`,
      [runIds],
    );
    expect(rows).toHaveLength(2);
    drafts = rows.map((row) => ({
      approvalId: row.id,
      recordId: row.record_id,
      subject: row.draft.subject,
    }));
    // Real drafts, from the model's own answer: what the inbox is about to edit is what
    // `fixtures/llm/draft.json` produced through `demoDraftSchema`, not a row written here.
    for (const draft of drafts) {
      expect(draft.recordId).toBe(acmeId);
      expect(draft.subject).toBe(FIXTURE_SUBJECT);
    }
  }, 600_000);

  it("emails the admin a link to each approval it opened", async () => {
    // The gates named no assignee, so the recipients are the admins — the bootstrapped one is
    // the only row with that role — and the message is `src/notify.ts`'s, sent by the worker.
    for (const draft of drafts) {
      const link = `${harness.baseUrl}/w/approvals/${draft.approvalId}`;
      const messages = await noticesFromMailpit(harness, ADMIN_EMAIL, link);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toContain("demoDraft");
    }
  }, 300_000);

  it("approves both drafts from the inbox in one batch, with one of them edited", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    const [edited, untouched] = [drafts[0]!, drafts[1]!];
    try {
      await signInAsMember(harness, page);

      await page.goto(`${harness.baseUrl}/w/approvals`);
      for (const draft of drafts) {
        await subjectBox(page, draft.approvalId).waitFor({ state: "visible" });
      }

      await subjectBox(page, edited.approvalId).fill(EDITED_SUBJECT);
      for (const draft of drafts) {
        await page.locator(`input[name="ids"][value="${draft.approvalId}"]`).check();
      }
      decidedAt = Date.now();
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForURL(`${harness.baseUrl}/w/approvals`);
      for (const draft of drafts) {
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
    } finally {
      await context.close();
    }
  }, 600_000);

  it("sends both emails, opens the follow-up task, and takes a label on the record", async () => {
    const { context, page } = await openWithAuthenticator(harness);
    try {
      // Both decisions carried their run past the gate: `actions.perform` on a channel that
      // cannot dedupe, so each run's own `send:<record>` key is what makes this two sends and
      // not four.
      const subjects = await subjectsFromMailpit(harness, ACME_CONTACT, decidedAt, 2, 120_000);
      expect(subjects).toContain(EDITED_SUBJECT);
      expect(subjects).toContain(FIXTURE_SUBJECT);

      const { rows: actions } = await harness.pool.query<{
        status: string;
        external_id: string | null;
        subject: string;
      }>(
        `SELECT status, external_id, request->>'subject' AS subject FROM hf_action_log
         WHERE channel = 'email' AND record_id = $1 ORDER BY id DESC LIMIT 2`,
        [acmeId],
      );
      expect(actions.map((row) => row.status)).toEqual(["ok", "ok"]);
      expect(actions.every((row) => row.external_id !== null)).toBe(true);
      expect(actions.map((row) => row.subject).sort()).toEqual(
        [EDITED_SUBJECT, FIXTURE_SUBJECT].sort(),
      );

      await signInAsMember(harness, page);
      await page.goto(`${harness.baseUrl}/w/demoNote/${acmeId}`);
      await page.getByText(`Follow up with ${ACME}`).first().waitFor({ state: "visible" });
      await page.getByText("outreach.sent").first().waitFor({ state: "visible" });
      // What went out is what was typed into the box, not only what the model proposed.
      await page.getByText(EDITED_SUBJECT).first().waitFor({ state: "visible" });

      await page.getByRole("button", { name: "Label up" }).click();
      await page.getByText("up on record").first().waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  }, 600_000);

  /**
   * Redeploy case 4's assertions, through the status endpoint. The flow that parks is a
   * `resolve`-queue one on purpose: a pause zeroes `llm` and `actions` — the two queues that
   * spend money and reach outside — and leaves `resolve` alone precisely so that what stops a
   * run is the step gate and not a dequeue that never happened. So the park is arranged rather
   * than timed: the run is dispatched, reads the gate, and concludes.
   */
  it("parks the next flow under pause and finishes it on resume with no extra calls", async () => {
    const { app, flows, inputs } = runtime;
    const calls = await llmCallCount();
    const token = randomUUID();
    await harness.pool.query("UPDATE hf_app_state SET write_token_hash = $1 WHERE id = 1", [
      hashStatusToken(token),
    ]);

    // Unauthenticated first, because a pause lever anyone can pull is worse than none.
    expect((await statusRequest("pause", undefined)).status).toBe(401);
    const paused = await statusRequest("pause", token);
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ paused: true });
    // The write token reads as well as writes, which is what a deploy check uses.
    expect(await (await statusRequest("status", token, "GET")).json()).toMatchObject({
      paused: true,
    });

    const started = await app.runs.start(flows.resolve, inputs.resolve);
    await waitForRunStatus(harness, started.runId, "paused");
    // The first attempt's workflow is the run's own id; every later one carries `:<attempt>`.
    expect(await runRow(started.runId)).toMatchObject({
      attempt: 1,
      status: "paused",
      current_workflow_id: started.runId,
    });
    // A suspended run is a *finished* workflow, not a parked one: that is the whole of why a
    // redeploy can take the next attempt on new code.
    expect(await workflowStatus(started.runId)).toBe("SUCCESS");

    const resumed = await statusRequest("resume", token);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      paused: false,
      reconciled: {
        reattempted: expect.arrayContaining([
          { runId: started.runId, attempt: 2, workflowId: `${started.runId}:2`, reason: "resumed" },
        ]),
      },
    });

    await waitForRunStatus(harness, started.runId, "done");
    expect(await runRow(started.runId)).toMatchObject({
      attempt: 2,
      current_workflow_id: `${started.runId}:2`,
    });
    // The point of the case: the pause and the resume cost nothing at the provider.
    expect(await llmCallCount()).toBe(calls);
  }, 600_000);
});

/**
 * The app as both halves hold it, plus a worker to run the flows.
 *
 * Imported here and not at the top: `defineApp()` reads `HF_BUILD_SHA` when the module is
 * evaluated, and `startHarness()` is what fills the environment. The worker is
 * `tests/worker-fixture.ts` rather than `worker.ts` because that one starts no schedule tick,
 * and it runs on the web server's own `HF_BUILD_SHA`: the attempt a decision enqueues is
 * dispatched by application version, so a worker on another one would leave every run waiting.
 */
async function bringUpWorker(): Promise<Runtime> {
  const [hyperfixation, collect, resolve, score, draft, source, resolver, scorer, workflows, testing] =
    await Promise.all([
      import("../../src/hyperfixation"),
      import("../../src/flows/collect-demo-source"),
      import("../../src/flows/resolve-demo-source"),
      import("../../src/flows/score-demo-notes"),
      import("../../src/flows/draft-demo-outreach"),
      import("../../src/sources/demo"),
      import("../../src/resolvers/demo"),
      import("../../src/scorers/demo"),
      import("@hyperfixation/workflows"),
      import("@hyperfixation/testing"),
    ]);

  const { app, recordTables } = hyperfixation;
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
  } catch (error) {
    // Whatever went wrong, the worker holds this app's advisory lock until it dies, and the
    // next run of this suite cannot start one while it does.
    await worker.kill().catch(() => undefined);
    throw error;
  }

  // A registry holds `Flow<never, unknown>` — input is contravariant — so starting a flow with
  // an input this file names needs the widening spelled out.
  const widen = (flow: unknown) => flow as import("@hyperfixation/workflows").Flow<unknown, unknown>;
  return {
    app,
    workflows,
    worker,
    flows: {
      collect: widen(collect.collectDemoSourceFlow),
      resolve: widen(resolve.resolveDemoSourceFlow),
      score: widen(score.scoreDemoNotesFlow),
      draft: widen(draft.draftDemoOutreachFlow),
    },
    inputs: {
      collect: { source: source.DEMO_SOURCE_NAME },
      resolve: { resolver: resolver.DEMO_RESOLVER_NAME, source: source.DEMO_SOURCE_NAME },
      score: { scorer: scorer.DEMO_SCORER_NAME },
    },
  };
}

/**
 * The draft flow picks the best-scoring unarchived record, so what this suite asserts depends on
 * nothing else being unarchived. `exit-bar.e2e.ts` seeds higher-scoring notes of its own, and a
 * second run of `pnpm test:e2e` would otherwise draft for one of those.
 */
async function onlyTheLoopsRecords(): Promise<void> {
  await harness.pool.query(
    `UPDATE demo_note SET archived_at = now()
     WHERE archived_at IS NULL AND normalized_name <> ALL($1::text[])`,
    [LOOP_RECORDS],
  );
  await harness.pool.query(
    "UPDATE demo_note SET archived_at = NULL WHERE normalized_name = ANY($1::text[])",
    [LOOP_RECORDS],
  );
  await harness.pool.query("DELETE FROM hf_label WHERE record_type = 'demoNote'");
}

/**
 * Two things this suite must not leave behind. A pause is app-wide, so a failure between the
 * pause and the resume would park every run of every later suite; and the loop's records carry
 * no `stage`, so leaving them unarchived puts an "Other" column on the board `exit-bar.e2e.ts`
 * asserts the shape of.
 */
async function leaveTheDatabaseAsItWasFound(): Promise<void> {
  if (runtime === undefined) return;
  const { rows } = await harness.pool.query<{ paused: boolean }>(
    "SELECT paused FROM hf_app_state WHERE id = 1",
  );
  if (rows[0]?.paused === true) await runtime.app.resume({ userId: "e2e" });
  await harness.pool.query(
    "UPDATE demo_note SET archived_at = now() WHERE normalized_name = ANY($1::text[])",
    [LOOP_RECORDS],
  );
}

function statusRequest(
  route: "status" | "pause" | "resume",
  token: string | undefined,
  method = "POST",
): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/status${route === "status" ? "" : `/${route}`}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function llmCallCount(): Promise<number> {
  const { rows } = await harness.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM hf_llm_call",
  );
  return rows[0]!.count;
}

async function runRow(
  runId: string,
): Promise<{ status: string; attempt: number; current_workflow_id: string } | undefined> {
  const { rows } = await harness.pool.query<{
    status: string;
    attempt: number;
    current_workflow_id: string;
  }>("SELECT status, attempt, current_workflow_id FROM hf_run WHERE run_id = $1", [runId]);
  return rows[0];
}

async function workflowStatus(workflowId: string): Promise<string | undefined> {
  const { rows } = await harness.pool.query<{ status: string }>(
    "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1",
    [workflowId],
  );
  return rows[0]?.status;
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
