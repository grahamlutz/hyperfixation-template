import { randomUUID } from "node:crypto";
import type { AdminField, AdminResource } from "@hyperfixation/admin";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { adminRouter, currentBudgetPeriod, getRow, listRows, type AdminRow } from "@/admin";
import { BudgetForm } from "./budget";
import { setAppBudget } from "./budget-actions";
import { BUDGET_ERROR_PARAM, offersSetBudget } from "./budget-form";
import { DraftRunForm } from "./draft-run";
import { startDraftRun } from "./draft-run-actions";
import { DRAFT_RUN_ERROR_PARAM, DRAFT_RUN_STARTED_PARAM } from "./draft-run-form";

/**
 * The admin, behind one catch-all route. `@hyperfixation/admin` generates every resource from
 * the Drizzle metadata core and this app already have, so there is nothing per-app to write
 * here beyond the gate and the rendering.
 *
 * The gate is `route()`'s, not this file's, and it runs **before** the path is resolved. A
 * member without the `admin` role gets a **404**, not a 403 and not a sign-in prompt, and gets
 * the same 404 on `/admin/widgets` as on `/admin/users` — the difference between those two
 * answers would be a map of the admin area. A code-factor session is confined to `/auth/*` and
 * 404s here too rather than being offered a step-up that would confirm the area exists. A path
 * the admin does not serve answers the same way, through Next's own `notFound()`.
 *
 * Reading rows is this file's job and not the package's: `@hyperfixation/admin` resolves a
 * route and refuses one, and cannot depend on `next` any more than `@hyperfixation/auth` can.
 *
 * One resource is more than a table shown as text: a budget period carries the `set-budget`
 * action, and a row that offers it gets the form below its fields.
 */
export default async function AdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path = [] } = await params;
  const router = adminRouter();
  const route = await router.route(path);
  if (route === undefined) notFound();

  if (route.kind === "index") {
    const search = await searchParams;
    return (
      <Shell>
        <h1>__APP_NAME__ admin</h1>
        <ul>
          {router.resources.all().map((resource) => (
            <li key={resource.name}>
              <Link href={`/admin/${resource.name}`}>{resource.name}</Link>
            </li>
          ))}
        </ul>
        <DraftRunForm
          keySeed={randomUUID()}
          startedRunId={textOf(search, DRAFT_RUN_STARTED_PARAM)}
          error={textOf(search, DRAFT_RUN_ERROR_PARAM)}
          action={startDraftRun}
        />
      </Shell>
    );
  }

  if (route.kind === "list") {
    const { resource } = route;
    const shown = fieldsOf(resource, resource.list);
    const rows = await listRows(resource);
    return (
      <Shell>
        <h1>{resource.name}</h1>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {shown.map((field) => (
                <th key={field.name} style={CELL}>
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowId(resource, row)}>
                {shown.map((field, index) => (
                  <td key={field.name} style={CELL}>
                    {index === 0 ? (
                      <Link href={`/admin/${resource.name}/${rowId(resource, row)}`}>
                        {display(row[field.column])}
                      </Link>
                    ) : (
                      display(row[field.column])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Shell>
    );
  }

  const row = await getRow(route.resource, route.id);
  if (row === undefined) notFound();
  return (
    <Shell>
      <h1>
        {route.resource.name} / {route.id}
      </h1>
      <dl>
        {fieldsOf(route.resource, route.resource.view).map((field) => (
          <div key={field.name}>
            <dt>{field.label}</dt>
            <dd>{display(row[field.column])}</dd>
          </div>
        ))}
      </dl>
      {offersSetBudget(route.resource) ? (
        <BudgetForm
          period={route.id}
          budgetUsd={fieldValue(route.resource, row, "budgetUsd")}
          spentUsd={fieldValue(route.resource, row, "spentUsd")}
          currentPeriod={route.id === (await currentBudgetPeriod())}
          error={textOf(await searchParams, BUDGET_ERROR_PARAM)}
          action={setAppBudget}
        />
      ) : null}
    </Shell>
  );
}

/** What an action redirected back with. Bounded, and rendered as text by React. */
function textOf(
  search: Record<string, string | string[] | undefined> | undefined,
  param: string,
): string | undefined {
  const value = search?.[param];
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text === "" ? undefined : text.slice(0, 200);
}

function fieldValue(resource: AdminResource, row: AdminRow, name: string): string {
  const field = resource.fields.find((candidate) => candidate.name === name);
  return field === undefined ? "—" : display(row[field.column]);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={{ padding: "2rem" }}>
      <p>
        <Link href="/admin">admin</Link>
      </p>
      {children}
    </main>
  );
}

/** The primary key's value, by its SQL column. `listRows` selects it whether `list` names it or not. */
function rowId(resource: AdminResource, row: AdminRow): string {
  const key = resource.fields.find((field) => field.name === resource.primaryKey[0]);
  return key === undefined ? "" : String(row[key.column] ?? "");
}

function fieldsOf(resource: AdminResource, names: readonly string[]): AdminField[] {
  return names
    .map((name) => resource.fields.find((field) => field.name === name))
    .filter((field): field is AdminField => field !== undefined);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const CELL: CSSProperties = {
  border: "1px solid currentColor",
  padding: "0.25rem 0.5rem",
  textAlign: "left",
};
