import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { workspaceRequest } from "@/workspace";
import { addRecordLabel, archiveRecord } from "./actions";
import { HomeScreen, Placeholder, RecordScreen, Shell } from "./views";

/**
 * The whole workspace, behind one catch-all route.
 *
 * `app.workspace.route(path)` resolves the segments below `/w` to a `kind` and the registration
 * it names; this file renders one screen per kind and reads its rows through `app.workspace.*`.
 * The app owns *what* it registers — the record types, their stages, its pages — and core owns
 * what a path means, which is what makes a core release an upgrade rather than a rewrite.
 *
 * The session gate is `src/workspace.ts`'s and runs before the path is resolved, so a 404 here
 * is only ever a route the workspace does not serve — never a refusal. A stranger is redirected
 * to `/auth/sign-in` whatever they asked for.
 */
export default async function WorkspacePage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const { app, session, actor } = await workspaceRequest(["/w", ...path].join("/"));

  const route = app.workspace.route(path);
  if (route === undefined) notFound();

  const shell = (children: ReactNode) => (
    <Shell nav={app.workspace.nav()} email={session.user.email ?? session.user.id}>
      {children}
    </Shell>
  );

  if (route.kind === "home") {
    return shell(
      <HomeScreen view={await app.workspace.home({ userId: actor.userId })} appName={app.name} />,
    );
  }

  if (route.kind === "record") {
    const view = await app.workspace.record(route.record.recordType, route.id);
    // A registered type with no such row: the route resolves and the record does not exist.
    if (view === undefined) notFound();
    return shell(
      <RecordScreen view={view} labelAction={addRecordLabel} archiveAction={archiveRecord} />,
    );
  }

  if (route.kind === "board") {
    return shell(
      <Placeholder
        title={route.record.title ?? route.record.recordType}
        coming="The pipeline board is coming next."
      />,
    );
  }

  if (route.kind === "inbox") {
    return shell(<Placeholder title="Inbox" coming="The approval inbox is coming next." />);
  }

  if (route.kind === "approval") {
    return shell(
      <Placeholder title={`Approval ${route.id}`} coming="The approval inbox is coming next." />,
    );
  }

  return shell(<Placeholder title={route.page.title} coming="This page has nothing on it yet." />);
}
