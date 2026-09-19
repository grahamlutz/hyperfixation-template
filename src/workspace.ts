import { ADMIN_ROLE, hasRole, type AuthSession } from "@hyperfixation/auth";
import { WORKSPACE_BASE_PATH } from "@hyperfixation/core/workspace";
import { requireSession } from "./auth";
import { attachedApp } from "./web";
import type { app } from "./hyperfixation";

/**
 * The workspace's one entry: the guard, the attached app, and who the reads are made as.
 *
 * `@hyperfixation/core/workspace` is descriptors — paths, nav items, flattened drafts — and
 * `app.workspace.*` is the reads; neither knows who is asking. That mapping is this app's,
 * because the session is, so it happens once here rather than in every page and action.
 */

/** What every workspace read and decision is scoped by. */
export interface WorkspaceActor {
  userId: string;
  /** The admin sees every pending approval, and may decide one assigned to someone else. */
  admin: boolean;
}

/**
 * The session narrowed to what `app.workspace` takes. `role` is optional on better-auth's user
 * and free text in the column, so the test is `hasRole` and not an equality: a role of `Admin`
 * or of ` admin ` is the same role, and an absent one is simply not it.
 */
export function actorOf(session: AuthSession): WorkspaceActor {
  return { userId: session.user.id, admin: hasRole(session.user, ADMIN_ROLE) };
}

export interface WorkspaceRequest {
  app: typeof app;
  session: AuthSession;
  actor: WorkspaceActor;
}

/**
 * The gate states no `factor`: the policy reads `/w/*` as the app area, whose bar is a passkey.
 * A stranger is redirected to `/auth/sign-in` and a session holding only an emailed code to
 * `/auth/passkey` — the redirect, not the 404, because unlike `/admin` the workspace has
 * nothing to withhold about its own existence.
 */
export async function workspaceRequest(pathname = WORKSPACE_BASE_PATH): Promise<WorkspaceRequest> {
  const session = await requireSession({ pathname });
  return { app: await attachedApp(), session, actor: actorOf(session) };
}
