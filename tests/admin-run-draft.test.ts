import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { AccessRefused, createSessionGuard, type AuthSession } from "@hyperfixation/auth";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startDraftRunFromForm,
  DRAFT_LIMIT_FIELD,
  DRAFT_MIN_SCORE_FIELD,
  DRAFT_RUN_KEY_FIELD,
  type DraftRunOutcome,
} from "../app/(admin)/admin/[[...path]]/draft-run-form";
import { DRAFT_DEMO_OUTREACH, draftDemoOutreachFlow } from "../src/flows/draft-demo-outreach";
import { app, recordTables } from "../src/hyperfixation";

/**
 * What the admin's draft-outreach control does, over a real database: the half of the page that
 * has no markup.
 *
 * `app.runs.start` is the real one, on a real control plane, because what is worth asserting is
 * the row it writes — that a submission starts exactly one run, and that the same key posted
 * twice starts none the second time. No worker is spawned: the enqueue is part of `runs.start`'s
 * own transaction, and nothing here needs the run to be picked up.
 *
 * The guard is the real one too — `createSessionGuard` over a fabricated session — so "a member
 * cannot start a run" is asserted against the policy the app runs. It throws `AccessRefused`
 * here because there is no Next to divert into; in the app that same decision is `notFound()`.
 */
const ADMIN: AuthSession = { factor: "passkey", user: { id: "admin-1", role: "admin" } };
const MEMBER: AuthSession = { factor: "passkey", user: { id: "member-1", role: "member" } };
const CODE_ONLY: AuthSession = { factor: "code", user: { id: "admin-1", role: "admin" } };

interface RunRow {
  run_id: string;
  input: { minScore: number; limit: number };
}

describe("the admin's draft-outreach form", () => {
  let database: TestDatabase;
  let pool: Pool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase({
      recordTables,
      appMigrationsDir: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    pool = new Pool({ connectionString: database.applicationUrl, max: 2 });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
    app.attach({ pool, client });
  }, 120_000);

  afterAll(async () => {
    app.detach();
    await resetClient();
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM hf_run");
  });

  it("starts one run carrying what was typed, and links it by id", async () => {
    const outcome = await post(ADMIN, { minScore: "0.75", limit: "3", key: "deadbeef-0001" });

    const runs = await runsStarted();
    expect(runs).toHaveLength(1);
    expect(outcome).toEqual({ runId: runs[0]!.run_id });
    expect(runs[0]!.input).toEqual({ minScore: 0.75, limit: 3 });
  });

  it("answers a repeat of the same submission with the run it already started", async () => {
    const first = await post(ADMIN, { minScore: "0.75", limit: "3", key: "deadbeef-0002" });
    const again = await post(ADMIN, { minScore: "0.75", limit: "3", key: "deadbeef-0002" });

    expect(again).toEqual(first);
    expect(await runsStarted()).toHaveLength(1);
  });

  /** The key is the run's identity, so a second submission of the form is a second run. */
  it("starts a second run for a second key", async () => {
    await post(ADMIN, { minScore: "0.75", limit: "3", key: "deadbeef-0003" });
    await post(ADMIN, { minScore: "0.75", limit: "3", key: "deadbeef-0004" });

    expect(await runsStarted()).toHaveLength(2);
  });

  it("refuses a member, and a session holding only an emailed code", async () => {
    await expect(post(MEMBER, { minScore: "0.5", limit: "1" })).rejects.toBeInstanceOf(
      AccessRefused,
    );
    await expect(post(CODE_ONLY, { minScore: "0.5", limit: "1" })).rejects.toBeInstanceOf(
      AccessRefused,
    );

    expect(await runsStarted()).toHaveLength(0);
  });

  it("shows a refusal instead of starting a run on a score that is not one", async () => {
    for (const minScore of ["-0.1", "1.5", "", " ", "abc", "1e400"]) {
      const outcome = await post(ADMIN, { minScore, limit: "2" });

      expect(outcome.error).toContain("between 0 and 1");
    }
    expect(await runsStarted()).toHaveLength(0);
  });

  it("shows a refusal instead of starting a run on a limit that is not one", async () => {
    for (const limit of ["0", "11", "2.5", "", "abc"]) {
      const outcome = await post(ADMIN, { minScore: "0.5", limit });

      expect(outcome.error).toContain("between 1 and 10");
    }
    expect(await runsStarted()).toHaveLength(0);
  });

  function post(
    session: AuthSession,
    typed: { minScore: string; limit: string; key?: string },
  ): Promise<DraftRunOutcome> {
    const formData = new FormData();
    formData.set(DRAFT_MIN_SCORE_FIELD, typed.minScore);
    formData.set(DRAFT_LIMIT_FIELD, typed.limit);
    if (typed.key !== undefined) formData.set(DRAFT_RUN_KEY_FIELD, typed.key);
    return startDraftRunFromForm(
      {
        requireSession: createSessionGuard({ getSession: async () => session }),
        start: (input, options) => app.runs.start(draftDemoOutreachFlow, input, options),
      },
      formData,
    );
  }

  async function runsStarted(): Promise<RunRow[]> {
    const { rows } = await pool.query<RunRow>(
      "SELECT run_id, input FROM hf_run WHERE flow = $1 ORDER BY started_at",
      [DRAFT_DEMO_OUTREACH],
    );
    return rows;
  }
});
