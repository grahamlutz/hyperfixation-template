/**
 * The admin, behind one catch-all route. `@hyperfixation/admin` generates every resource from
 * the Drizzle metadata core and this app already have, so there is nothing per-app to write
 * here beyond the gate.
 *
 * The gate is not a redirect. A member without the `admin` role gets a **404**, not a 403 and
 * not a sign-in prompt: the existence of an admin at this path is itself not theirs to learn.
 * A code-factor session is confined to `/auth/*` and never reaches here either.
 *
 * TODO(track C): gate on `requireSession({ factor: 'passkey', role: ADMIN_ROLE })` and call
 * `notFound()` on `AccessRefused`. The package landed while this template was being written;
 * the guard's host is still track C's to place.
 * TODO(track D): render `@hyperfixation/admin`, which is a placeholder today.
 */
export default async function AdminPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  return (
    <main style={{ padding: "2rem" }}>
      <h1>__APP_NAME__ admin</h1>
      <p>Admin route: /admin/{path.join("/")}</p>
    </main>
  );
}
