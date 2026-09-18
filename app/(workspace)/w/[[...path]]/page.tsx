import { requireSession } from "@/auth";

/**
 * The whole workspace, behind one catch-all route.
 *
 * Every screen a run produces — records, activity, tasks, approvals, outcomes — is rendered by
 * `@hyperfixation/core`, from the registrations in `src/hyperfixation.ts`. The app owns *what*
 * it registers, not how the workspace draws it, which is what makes a core release an upgrade
 * rather than a rewrite. The one thing this file owns is the session gate, because the policy
 * is the app's boundary and not core's.
 *
 * The gate states no `factor`: the pathname is what it is given, and the policy reads `/w/*` as
 * the app area, whose bar is a passkey. A stranger is redirected to `/auth/sign-in` and a
 * session holding only an emailed code to `/auth/passkey` — the redirect, not the 404, because
 * unlike `/admin` the workspace has nothing to withhold about its own existence.
 *
 * TODO(phase 2): render `@hyperfixation/core/workspace`; core publishes no UI entry point yet.
 */
export default async function WorkspacePage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const session = await requireSession({ pathname: ["/w", ...path].join("/") });

  return (
    <main style={{ padding: "2rem" }}>
      <h1>__APP_NAME__</h1>
      <p>Signed in as {session.user.email ?? session.user.id}.</p>
      <p>Workspace route: /w/{path.join("/")}</p>
    </main>
  );
}
