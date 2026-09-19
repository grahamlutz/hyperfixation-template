"use server";
import { WORKSPACE_BASE_PATH } from "@hyperfixation/core/workspace";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { workspaceRequest } from "@/workspace";
import { DECIDE_ERROR_PARAM, decideFromForm } from "./decide-form";

/**
 * The inbox's one action: a batch of approvals decided in a single `app.workspace.decide` call,
 * with the session's `userId`/`admin` and the form's own replay key.
 *
 * It always redirects, and a refusal travels back as `?error=` rather than as a 500 — the
 * allowlist an edit broke, or a row assigned to somebody else, is something the decider has to
 * read and fix, not a stack trace. The redirect is also what clears a stale error off the URL
 * after the next submission.
 */

const INBOX_PATH = `${WORKSPACE_BASE_PATH}/approvals`;

export async function decideApprovals(formData: FormData): Promise<void> {
  const { app, actor } = await workspaceRequest();
  const outcome = await decideFromForm({ workspace: app.workspace, actor }, formData);

  const back = returnTo(formData);
  if (outcome.error !== undefined) {
    redirect(`${back}?${new URLSearchParams({ [DECIDE_ERROR_PARAM]: outcome.error }).toString()}`);
  }

  // Home counts the same rows the inbox lists, and each record page shows its own pending
  // approvals, so all three are stale the moment the batch commits.
  revalidatePath(WORKSPACE_BASE_PATH);
  revalidatePath(INBOX_PATH);
  for (const { recordType, recordId } of outcome.records) {
    revalidatePath(`${WORKSPACE_BASE_PATH}/${recordType}/${recordId}`);
  }
  // Never back to `/w/approvals/<id>`: that row is decided and the page is a 404 now.
  redirect(INBOX_PATH);
}

/** The page that posted, if it is one of this app's own; never an address off the form. */
function returnTo(formData: FormData): string {
  const value = String(formData.get("returnTo") ?? "");
  return value.startsWith(`${INBOX_PATH}/`) || value === INBOX_PATH ? value : INBOX_PATH;
}
