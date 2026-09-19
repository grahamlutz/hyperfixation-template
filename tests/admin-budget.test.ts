import { fileURLToPath } from "node:url";
import { createSetBudgetAction, BUDGET_SET_OPERATION } from "@hyperfixation/admin";
import { AccessRefused, createSessionGuard, type AuthSession } from "@hyperfixation/auth";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setBudgetFromForm,
  BUDGET_PERIOD_FIELD,
  BUDGET_USD_FIELD,
} from "../app/(admin)/admin/[[...path]]/budget-form";
import { recordTables } from "../src/hyperfixation";

/**
 * What the admin's budget form does, over a real database: the half of the page that has no
 * markup.
 *
 * The form is posted through `setBudgetFromForm` rather than through the server action, because
 * the action is a `revalidatePath` and a redirect around this call. The guard, though, is the
 * real one — `createSetBudgetAction` with `createSessionGuard` over a fabricated session — so
 * "a member cannot set the budget" is asserted against the policy the app runs and not against
 * a stand-in for it. The guard throws `AccessRefused` here because there is no Next to divert
 * into; in the app that same decision is `notFound()`.
 */
const PERIOD = "2026-09";
const ADMIN: AuthSession = { factor: "passkey", user: { id: "admin-1", role: "admin" } };
const MEMBER: AuthSession = { factor: "passkey", user: { id: "member-1", role: "member" } };

describe("the admin's budget form", () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase({
      recordTables,
      appMigrationsDir: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    pool = new Pool({ connectionString: database.applicationUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM hf_audit");
    await pool.query("DELETE FROM hf_budget_period");
    await pool.query(
      "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, '100', '12.5')",
      [PERIOD],
    );
  });

  it("writes the admin's value and audits who set it", async () => {
    const outcome = await post(ADMIN, "250.50");

    expect(outcome).toEqual({ period: PERIOD });
    expect(await budgetOf(PERIOD)).toEqual({ budget: "250.5000", spent: "12.5000" });

    const { rows } = await pool.query<{ actor_id: string; target_id: string; meta: unknown }>(
      "SELECT actor_id, target_id, meta FROM hf_audit WHERE action = $1",
      [BUDGET_SET_OPERATION],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ADMIN.user.id);
    expect(rows[0]!.target_id).toBe(PERIOD);
    expect(rows[0]!.meta).toMatchObject({ previousBudgetUsd: "100.0000", budgetUsd: "250.5000" });
  });

  it("refuses a member, and writes nothing", async () => {
    await expect(post(MEMBER, "250.50")).rejects.toBeInstanceOf(AccessRefused);

    expect(await budgetOf(PERIOD)).toEqual({ budget: "100.0000", spent: "12.5000" });
    expect(await auditCount()).toBe(0);
  });

  it("shows a refusal instead of writing a value that is not a budget", async () => {
    for (const typed of ["-1", "", " ", "abc", "1e400"]) {
      const outcome = await post(ADMIN, typed);

      expect(outcome.error).toContain("finite, non-negative");
    }
    expect(await budgetOf(PERIOD)).toEqual({ budget: "100.0000", spent: "12.5000" });
    expect(await auditCount()).toBe(0);
  });

  it("says so when the period has no row yet", async () => {
    const outcome = await post(ADMIN, "10", "1999-01");

    expect(outcome.error).toContain("no budget row for 1999-01");
    expect(await auditCount()).toBe(0);
  });

  /** A ceiling below what the period has already spent: the kill-lever, and allowed. */
  it("allows a budget below what the period has already spent", async () => {
    const outcome = await post(ADMIN, "0");

    expect(outcome.error).toBeUndefined();
    expect(await budgetOf(PERIOD)).toEqual({ budget: "0.0000", spent: "12.5000" });
  });

  function post(session: AuthSession, budgetUsd: string, period = PERIOD) {
    const formData = new FormData();
    formData.set(BUDGET_PERIOD_FIELD, period);
    formData.set(BUDGET_USD_FIELD, budgetUsd);
    const setBudget = createSetBudgetAction({
      pool,
      requireSession: createSessionGuard({ getSession: async () => session }),
    });
    return setBudgetFromForm({ setBudget }, formData);
  }

  async function budgetOf(period: string): Promise<{ budget: string; spent: string }> {
    const { rows } = await pool.query<{ budget: string; spent: string }>(
      "SELECT budget_usd::text AS budget, spent_usd::text AS spent FROM hf_budget_period " +
        "WHERE period = $1",
      [period],
    );
    return rows[0]!;
  }

  async function auditCount(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM hf_audit");
    return rows[0]!.n;
  }
});
