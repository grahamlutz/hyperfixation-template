import type { AdminField, AdminResource } from "@hyperfixation/admin";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { adminRouter, getRow, listRows, type AdminRow } from "@/admin";

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
 */
export default async function AdminPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const router = adminRouter();
  const route = await router.route(path);
  if (route === undefined) notFound();

  if (route.kind === "index") {
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
    </Shell>
  );
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
