import { WORKSPACE_BASE_PATH } from "@hyperfixation/core/workspace";
import {
  DRAFT_LIMIT_DEFAULT,
  DRAFT_LIMIT_FIELD,
  DRAFT_LIMIT_MAX,
  DRAFT_MIN_SCORE_DEFAULT,
  DRAFT_MIN_SCORE_FIELD,
} from "./draft-run-form";
import { RunKey } from "./run-key";

/**
 * The admin's one start: `draftDemoOutreach` over the top scored notes.
 *
 * Nothing schedules that flow — it asks a human, so a second run over the same record drafts a
 * second email — and until this form there was no way to start one outside a test. It is the
 * other half of the approval inbox: this is where the approvals a phone decides come from.
 *
 * The action arrives as a prop rather than being imported, which is what lets a
 * `react-dom/server` test render this without Next's server-action runtime; `budget.tsx` and
 * the workspace's screens are built the same way.
 */
export interface DraftRunFormProps {
  /** The server render's replay token; the browser replaces it on mount. */
  keySeed: string;
  /** The run the last submission started, shown with the inbox it fills. */
  startedRunId?: string | undefined;
  error?: string | undefined;
  action: (formData: FormData) => void | Promise<void>;
}

export function DraftRunForm({ keySeed, startedRunId, error, action }: DraftRunFormProps) {
  return (
    <section>
      <h2>Draft outreach for the top scored notes</h2>
      <p>
        One run drafts an email per note that scores at least the minimum, and stops at each one
        for a human — the drafts land in the approval inbox.
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {startedRunId === undefined ? null : (
        <p>
          Started run {startedRunId} —{" "}
          <a href={`${WORKSPACE_BASE_PATH}/approvals`}>approvals</a>
        </p>
      )}
      <form action={action}>
        <RunKey seed={keySeed} />
        <label htmlFor={DRAFT_MIN_SCORE_FIELD}>Minimum score</label>{" "}
        <input
          id={DRAFT_MIN_SCORE_FIELD}
          name={DRAFT_MIN_SCORE_FIELD}
          type="number"
          min="0"
          max="1"
          step="0.05"
          defaultValue={DRAFT_MIN_SCORE_DEFAULT}
        />{" "}
        <label htmlFor={DRAFT_LIMIT_FIELD}>Notes at most</label>{" "}
        <input
          id={DRAFT_LIMIT_FIELD}
          name={DRAFT_LIMIT_FIELD}
          type="number"
          min="1"
          max={DRAFT_LIMIT_MAX}
          step="1"
          defaultValue={DRAFT_LIMIT_DEFAULT}
        />{" "}
        <button type="submit">Draft outreach</button>
      </form>
    </section>
  );
}
