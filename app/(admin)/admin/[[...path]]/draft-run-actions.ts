"use server";
import { ADMIN_BASE_PATH } from "@hyperfixation/admin";
import { redirect } from "next/navigation";
import { requireSession } from "@/auth";
import { draftDemoOutreachFlow } from "@/flows/draft-demo-outreach";
import { attachedApp } from "@/web";
import {
  DRAFT_RUN_ERROR_PARAM,
  DRAFT_RUN_STARTED_PARAM,
  startDraftRunFromForm,
} from "./draft-run-form";

/**
 * The admin's one start: `draftDemoOutreach`, enqueued through `app.runs.start`.
 *
 * The app is attached inside the `start` callback rather than before the call, so a member
 * posting this form is refused by the guard in `draft-run-form.ts` before this process opens a
 * control-plane connection on their behalf.
 *
 * It always redirects, the budget action's way: the started run's id and a refusal alike come
 * back on the admin index as a query parameter, which is also what clears the previous one.
 */
export async function startDraftRun(formData: FormData): Promise<void> {
  const outcome = await startDraftRunFromForm(
    {
      requireSession,
      start: async (input, options) =>
        (await attachedApp()).runs.start(draftDemoOutreachFlow, input, options),
    },
    formData,
  );

  const params =
    outcome.error === undefined
      ? { [DRAFT_RUN_STARTED_PARAM]: outcome.runId! }
      : { [DRAFT_RUN_ERROR_PARAM]: outcome.error };
  redirect(`${ADMIN_BASE_PATH}?${new URLSearchParams(params).toString()}`);
}
