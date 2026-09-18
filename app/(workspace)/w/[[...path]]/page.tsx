/**
 * The whole workspace, behind one catch-all route.
 *
 * Every screen a run produces — records, activity, tasks, approvals, outcomes — is rendered by
 * `@hyperfixation/core`, from the registrations in `src/hyperfixation.ts`. The app owns *what*
 * it registers, not how the workspace draws it, which is what makes a core release an upgrade
 * rather than a rewrite. The one thing this file owns is the session gate, because the policy
 * is the app's boundary and not core's.
 *
 * TODO(track C): gate on the `requireSession` that `createSessionGuard()` returns. The package
 * landed while this template was being written; what is still missing here is the guard's host
 * — the sign-in and step-up routes its refusals divert to — which is track C's to place.
 * TODO(phase 2): render `@hyperfixation/core/workspace`; core publishes no UI entry point yet.
 */
export default async function WorkspacePage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  return (
    <main style={{ padding: "2rem" }}>
      <h1>__APP_NAME__</h1>
      <p>Workspace route: /w/{path.join("/")}</p>
    </main>
  );
}
