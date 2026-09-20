/**
 * The one editable thing in the admin: a period's budget.
 *
 * The action arrives as a prop rather than being imported, which is what lets a
 * `react-dom/server` test render this without Next's server-action runtime — the workspace's
 * screens are built the same way.
 *
 * The period is a hidden field rather than a closure: the action acts on what it was posted,
 * and `budget-form.ts` is what turns that into a call. A refusal is rendered as text, which is
 * React's own escaping; nothing on this page builds markup from a value.
 */
export interface BudgetFormProps {
  period: string;
  /**
   * As stored, at the column's own scale — text, not a float this page rounded on the way
   * through. `spent_usd` carries the ledger's scale, so a sub-cent call is visible here.
   */
  budgetUsd: string;
  spentUsd: string;
  /** The period the next gate will read. An edit to any other one changes nothing today. */
  currentPeriod: boolean;
  error?: string | undefined;
  action: (formData: FormData) => void | Promise<void>;
}

export function BudgetForm({
  period,
  budgetUsd,
  spentUsd,
  currentPeriod,
  error,
  action,
}: BudgetFormProps) {
  return (
    <section>
      <h2>Budget</h2>
      <p>
        {period} — spent {spentUsd} of {budgetUsd}
      </p>
      <p>
        {currentPeriod
          ? "This is the current period: a new ceiling takes effect at the next gate."
          : "This is not the current period, so a change here does not affect what runs today."}
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <form action={action}>
        <input type="hidden" name="period" value={period} />
        <label htmlFor="budgetUsd">Budget (USD)</label>{" "}
        <input
          id="budgetUsd"
          name="budgetUsd"
          type="number"
          min="0"
          step="0.01"
          defaultValue={budgetUsd}
        />{" "}
        <button type="submit">Set budget</button>
      </form>
      {/* A ceiling below what the period has already spent is allowed on purpose: it is the
          kill-lever, and the next gate refuses every further call for the period. */}
    </section>
  );
}
