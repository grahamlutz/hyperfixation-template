import {
  ADMIN_BUDGET_PERIODS_RESOURCE,
  InvalidBudget,
  SET_BUDGET_ACTION,
  UnknownBudgetPeriod,
  type AdminResource,
  type SetBudgetAction,
} from "@hyperfixation/admin";

/**
 * The budget form's half without markup: one submission turned into one `setBudget` call.
 *
 * It is separate from the server action for the same reason `decide-form.ts` is — the action is
 * a guard, a revalidate and a redirect, and none of those are what is worth a test. What is
 * worth one is that the number a human typed is a budget before it reaches the action, and that
 * a refusal comes back as a sentence rather than as a 500.
 *
 * The authorisation is **not** here: `setBudget` is `createSetBudgetAction`'s, which takes the
 * actor from its own guarded session. Nothing on this form says who is submitting it.
 */

/** Where a refusal travels: `?error=` on the row the form was posted from. */
export const BUDGET_ERROR_PARAM = "error";
export const BUDGET_PERIOD_FIELD = "period";
export const BUDGET_USD_FIELD = "budgetUsd";

const NOT_A_BUDGET = "A budget must be a finite, non-negative number of dollars.";

export interface BudgetFormDeps {
  setBudget: SetBudgetAction;
}

export interface BudgetFormOutcome {
  period: string;
  /** Absent when the write happened. Bounded text, never an error's stack. */
  error?: string;
}

/** Whether this resource is the one the budget form belongs on, by its own action descriptor. */
export function offersSetBudget(resource: AdminResource): boolean {
  return (
    resource.name === ADMIN_BUDGET_PERIODS_RESOURCE &&
    resource.actions.some((action) => action.name === SET_BUDGET_ACTION)
  );
}

export async function setBudgetFromForm(
  deps: BudgetFormDeps,
  formData: FormData,
): Promise<BudgetFormOutcome> {
  const period = String(formData.get(BUDGET_PERIOD_FIELD) ?? "");
  const typed = String(formData.get(BUDGET_USD_FIELD) ?? "").trim();
  // `Number("")` is 0, which would silently zero a month's ceiling: a blank field is a mistake,
  // not a kill-lever pull. Everything else non-finite or negative is the action's own rule,
  // checked here too so a typo never reaches a transaction.
  const budgetUsd = typed === "" ? Number.NaN : Number(typed);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return { period, error: NOT_A_BUDGET };

  try {
    await deps.setBudget({ period, budgetUsd });
    return { period };
  } catch (error) {
    if (error instanceof InvalidBudget) return { period, error: NOT_A_BUDGET };
    if (error instanceof UnknownBudgetPeriod) {
      return {
        period,
        error: `There is no budget row for ${period} yet; the first gate of a period creates it.`,
      };
    }
    throw error;
  }
}
