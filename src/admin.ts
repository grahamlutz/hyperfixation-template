import { createAdminRouter, type AdminResource, type AdminRouter } from "@hyperfixation/admin";
import { requireSession } from "./auth";
import { pool } from "./web";

/**
 * The admin router, bound to this app's pool and this app's guard.
 *
 * `@hyperfixation/admin` resolves a route and refuses one; it deliberately reads no rows and
 * renders nothing, because it cannot depend on `next` any more than `auth` can. So the two
 * halves the page needs — the rows, and the page itself — live here and in
 * `app/(admin)/admin/[[...path]]`.
 */
let instance: AdminRouter | undefined;

export function adminRouter(): AdminRouter {
  instance ??= createAdminRouter({ pool: pool(), requireSession });
  return instance;
}

/** How many rows a list shows. Phase 2's admin gets paging; Phase 1 gets a ceiling. */
export const ADMIN_LIST_LIMIT = 100;

export type AdminRow = Record<string, unknown>;

/**
 * Every identifier in these two statements comes from the resource's Drizzle metadata — the
 * table name and each field's SQL column — and never from the URL. The one thing the request
 * supplies is the primary-key value, which is a parameter.
 */
function columns(resource: AdminResource, names: readonly string[]): string {
  const byName = new Map(resource.fields.map((field) => [field.name, field.column]));
  return names.map((name) => `"${byName.get(name)!}"`).join(", ");
}

/**
 * The list's own fields plus the primary key, which `list` need not name — `users` does not —
 * and without which a row could not be linked to its detail page.
 */
export async function listRows(resource: AdminResource): Promise<AdminRow[]> {
  const selected = [...new Set([...resource.primaryKey, ...resource.list])];
  const result = await pool().query(
    `SELECT ${columns(resource, selected)} FROM "${resource.table}" LIMIT ${ADMIN_LIST_LIMIT}`,
  );
  return result.rows as AdminRow[];
}

/**
 * The period the next gate will bill to. Read from the database rather than from this process's
 * clock, because `hf_budget_period.period` is stamped by `now() AT TIME ZONE 'UTC'` in the gate
 * and a web container an hour off would call the wrong month the current one.
 */
export async function currentBudgetPeriod(): Promise<string> {
  const result = await pool().query<{ period: string }>(
    "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period",
  );
  return result.rows[0]!.period;
}

export async function getRow(resource: AdminResource, id: string): Promise<AdminRow | undefined> {
  const key = resource.primaryKey[0];
  if (key === undefined) return undefined;
  const result = await pool().query(
    `SELECT ${columns(resource, resource.view)} FROM "${resource.table}" ` +
      `WHERE ${columns(resource, [key])} = $1`,
    [id],
  );
  return result.rows[0] as AdminRow | undefined;
}
