"use server";
import { ADMIN_BASE_PATH, ADMIN_BUDGET_PERIODS_RESOURCE } from "@hyperfixation/admin";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { adminRouter } from "@/admin";
import { BUDGET_ERROR_PARAM, setBudgetFromForm } from "./budget-form";

/**
 * The admin's one write: a period's ceiling, through `@hyperfixation/admin`'s own action.
 *
 * The action carries its own `requireSession({ factor: 'passkey', role: 'admin' })` and takes
 * the actor from that session, so a member posting this form gets the same 404 the page gives
 * them — the guard is not re-stated here, because a second copy of it is a second thing to get
 * wrong.
 *
 * It always redirects, the inbox's way: a refusal comes back as `?error=` on the row's own page
 * rather than as a 500, and the redirect is what clears a stale error after the next submission.
 */
export async function setAppBudget(formData: FormData): Promise<void> {
  const outcome = await setBudgetFromForm({ setBudget: adminRouter().actions.setBudget }, formData);
  const back = `${ADMIN_BASE_PATH}/${ADMIN_BUDGET_PERIODS_RESOURCE}/${encodeURIComponent(outcome.period)}`;

  if (outcome.error !== undefined) {
    redirect(`${back}?${new URLSearchParams({ [BUDGET_ERROR_PARAM]: outcome.error }).toString()}`);
  }

  // The list shows `budget_usd` too, and both pages read it fresh from the pool.
  revalidatePath(`${ADMIN_BASE_PATH}/${ADMIN_BUDGET_PERIODS_RESOURCE}`);
  revalidatePath(back);
  redirect(back);
}
