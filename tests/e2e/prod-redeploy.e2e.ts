import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTACT_ALLOWLIST } from "../../src/approvals/demo-draft";
import { draftDemoOutreachFlow } from "../../src/flows/draft-demo-outreach";
import { app } from "../../src/hyperfixation";
import { dockerAvailable, startProdStack, type ProdStack } from "./prod-stack";

/**
 * D4's bar, and the one claim the whole design rests on, asserted against the deployed stack
 * rather than a spawned worker: **a run crosses a deploy by restarting, not by resuming.**
 *
 * The sequence is the one a real release performs. A run stops at `waitForApproval` under
 * commit A, with attempt 1's workflow ended `SUCCESS` and nothing holding it. The flow's step
 * list then *changes* — a keyed `activity.record` is inserted before the gate — and the image
 * is rebuilt as commit B and all three containers recreated. The human decides, which bumps the
 * run to attempt 2 and enqueues `<run>:2`; B's worker re-runs the flow from the top, replays
 * the ledgered draft, runs the step that did not exist when attempt 1 ran, and sends once.
 *
 * What makes it a *redeploy* test and not a second copy of `draft-approval.test.ts` is the new
 * step's row: it can only exist if attempt 2 ran B's code, and `/api/status` naming B is the
 * other half of the same fact.
 *
 * The patch is applied to the **generated** app under the stack's temp directory, never to this
 * checkout — see `prod-stack.ts` for why the suite deploys a generated app at all.
 *
 * `pnpm test:prod`, and two image builds: budget several minutes.
 */

const COMMIT_A = randomBytes(20).toString("hex");
const COMMIT_B = randomBytes(20).toString("hex");

/** The kind only B's flow records. Attempt 1 cannot have written it. */
const NOTED_KIND = "redeploy.noted";

/** Above both fixture scores (0.82 and 0.21), so the flow's select can only find this record. */
const SEED_SCORE = 0.99;
const MIN_SCORE = 0.9;
const CONTACT = [...CONTACT_ALLOWLIST][0]!;

const docker = await dockerAvailable();
if (!docker) {
  console.warn("tests/e2e/prod-redeploy.e2e.ts skipped: `docker info` failed; is Docker running?");
}

describe.skipIf(!docker)("a redeploy across a step change", () => {
  let stack: ProdStack;
  let client: DBOSClient;
  let noteId: string;
  let runId: string;
  let approvalId: number;

  beforeAll(async () => {
    stack = await startProdStack({ sourceCommit: COMMIT_A });

    // Enqueued from here rather than through the web: `runs.start` writes `hf_run` and the
    // queue row in one control-plane transaction, and an enqueue from a client carries no
    // `application_version`, so the running container's worker is what dequeues it.
    client = await getClient({ appName: stack.appName, databaseUrl: stack.applicationUrl });
    app.attach({ pool: stack.pool, client });

    const { rows } = await stack.pool.query<{ id: string }>(
      "INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version) " +
        "VALUES ($1, $2, $3, $4, 1) RETURNING id::text AS id",
      ["redeploy target", "Family roofing contractor on the north side.", CONTACT, SEED_SCORE],
    );
    noteId = rows[0]!.id;

    const started = await app.runs.start(draftDemoOutreachFlow, { minScore: MIN_SCORE, limit: 1 });
    runId = started.runId;
    await waitForRun("waiting");
  }, 1_200_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await stack?.stop();
  });

  it("stopped attempt 1 at the approval, under the first commit", async () => {
    const run = await runRow();
    expect(run).toMatchObject({ attempt: 1, current_workflow_id: runId });

    const { rows } = await stack.pool.query<{ id: number; status: string; record_id: string }>(
      "SELECT id::int AS id, status, record_id FROM hf_approval WHERE run_id = $1",
      [runId],
    );
    expect(rows).toMatchObject([{ status: "pending", record_id: noteId }]);
    approvalId = rows[0]!.id;

    expect(await applicationVersion()).toBe(COMMIT_A);
    // Nothing of the new step exists yet, which is what makes its row later mean anything.
    expect(await notedRows()).toBe(0);
  });

  it(
    "deploys a changed step list as a new commit, recreating all three services",
    async () => {
      await insertNotedStep(stack.appDir);
      await stack.deploy(COMMIT_B);

      expect(await stack.exitCodeOf("migrate")).toBe(0);
      expect(await applicationVersion()).toBe(COMMIT_B);
      // The gate is still waiting: a redeploy does not decide anything, and reconcile leaves a
      // `waiting` run alone — its attempt ended, so there is nothing dead to bump.
      expect(await runRow()).toMatchObject({ attempt: 1, status: "waiting" });
    },
    1_200_000,
  );

  it("finishes on attempt 2, running the step that did not exist before", async () => {
    await app.workspace.decide({
      ids: [approvalId],
      decision: "approved",
      decisionKey: randomUUID(),
      userId: "redeploy-e2e",
      admin: true,
    });

    await waitForRun("done");
    expect(await runRow()).toMatchObject({
      attempt: 2,
      current_workflow_id: `${runId}:2`,
      status: "done",
    });
    expect(await notedRows()).toBe(1);
  });

  it("sent the email exactly once", async () => {
    const { rows } = await stack.pool.query<{ status: string; key: string }>(
      "SELECT status, key FROM hf_action_log WHERE record_id = $1 AND channel = 'email'",
      [noteId],
    );
    expect(rows).toMatchObject([{ status: "ok", key: `send:${noteId}` }]);
  });

  async function runRow(): Promise<{
    attempt: number;
    current_workflow_id: string;
    status: string;
    error: string | null;
  }> {
    const { rows } = await stack.pool.query<{
      attempt: number;
      current_workflow_id: string;
      status: string;
      error: string | null;
    }>(
      "SELECT attempt, current_workflow_id, status, error FROM hf_run WHERE run_id = $1",
      [runId],
    );
    return rows[0]!;
  }

  async function waitForRun(status: string): Promise<void> {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const row = await runRow();
      if (row.status === status) return;
      if (row.status === "failed") {
        throw new Error(`run ${runId} failed instead of reaching ${status}: ${row.error ?? "?"}`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `run ${runId} is ${row.status}, not ${status}:\n${await stack.logsOf("worker")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function notedRows(): Promise<number> {
    const { rows } = await stack.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM hf_activity WHERE record_type = 'demoNote' " +
        "AND record_id = $1 AND kind = $2",
      [noteId, NOTED_KIND],
    );
    return Number(rows[0]!.n);
  }

  async function applicationVersion(): Promise<string> {
    const response = await fetch(`${stack.baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${stack.readToken}` },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { applicationVersion: string }).applicationVersion;
  }
});

/**
 * The step-list change, written into the generated app's own copy of the flow: one keyed
 * `activity.record` immediately before `waitForApproval`, so attempt 2 reaches it and attempt 1
 * never had it. Keyed like everything else in the flow — the assertion is that it ran *once*,
 * which is only interesting because the key is what makes that true.
 *
 * Text substitution rather than a fixture file so that the flow stays one file with one history:
 * the anchor is a line of `src/flows/draft-demo-outreach.ts`, and an edit that moves it fails
 * here loudly instead of silently deploying an unchanged flow.
 */
const GATE_ANCHOR = "      const decision = await waitForApproval({";

const NOTED_STEP = [
  "      await step(",
  '        "noted",',
  "        async (ctx) => {",
  '          const { app } = await import("../hyperfixation");',
  "          await app.activity.record(ctx, {",
  '            recordType: "demoNote",',
  "            recordId: target.id,",
  `            kind: "${NOTED_KIND}",`,
  '            body: "inserted between two deploys",',
  "            key: `noted:${target.id}`,",
  "          });",
  "        },",
  "        { key: `noted:${target.id}` },",
  "      );",
  "",
].join("\n");

async function insertNotedStep(appDir: string): Promise<void> {
  const file = path.join(appDir, "src/flows/draft-demo-outreach.ts");
  const source = await readFile(file, "utf8");
  if (!source.includes(GATE_ANCHOR)) {
    throw new Error(`${file} no longer contains the approval gate this suite patches before`);
  }
  await writeFile(file, source.replace(GATE_ANCHOR, `${NOTED_STEP}${GATE_ANCHOR}`));
}
