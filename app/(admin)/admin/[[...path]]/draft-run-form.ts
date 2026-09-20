import { randomUUID } from "node:crypto";
import { ADMIN_ROLE, type RequireSession } from "@hyperfixation/auth";
import type { StartedRun } from "@hyperfixation/workflows";
import type { DraftDemoOutreachInput } from "@/flows/draft-demo-outreach";

/**
 * The draft-outreach control's half without markup: one submission turned into one
 * `app.runs.start` call.
 *
 * It is a plain module rather than the `"use server"` one beside it for `decide-form.ts`'s
 * reason — everything exported from a server-action file is an endpoint, and what is worth a
 * test here is the guard, the two numbers a human typed, and the double click that must not
 * start a second run.
 *
 * Unlike the budget form, the guard **is** here: `runs.start` is a control-plane operation with
 * no session of its own, so this is the only place the admin bar is stated for this write.
 */

/** Where a refusal and a started run travel: back onto the admin index. */
export const DRAFT_RUN_ERROR_PARAM = "draftError";
export const DRAFT_RUN_STARTED_PARAM = "draftRun";
export const DRAFT_RUN_KEY_FIELD = "runKey";
export const DRAFT_MIN_SCORE_FIELD = "minScore";
export const DRAFT_LIMIT_FIELD = "limit";

export const DRAFT_MIN_SCORE_DEFAULT = 0.5;
export const DRAFT_LIMIT_DEFAULT = 2;
export const DRAFT_LIMIT_MAX = 10;

const NOT_A_SCORE = "The minimum score must be a number between 0 and 1.";
const NOT_A_LIMIT = `The limit must be a whole number between 1 and ${DRAFT_LIMIT_MAX}.`;

/**
 * The run id a submission's key stands for. `hf_run.run_id` is the primary key, so a second
 * submission carrying the same key conflicts inside `runs.start`'s own transaction and neither
 * the row nor the enqueue happens twice — the double click is answered by the database rather
 * than by a window this page would have to keep.
 */
const RUN_ID_PREFIX = "admin-draft-";

/** A key minted by `run-key.tsx` or by the server render it seeds; anything else is not one. */
const KEY_PATTERN = /^[0-9a-f-]{8,64}$/i;

/** Postgres' `unique_violation`: this key already started its run. */
const UNIQUE_VIOLATION = "23505";

export type StartDraftRun = (
  input: DraftDemoOutreachInput,
  options: { runId: string },
) => Promise<StartedRun>;

export interface DraftRunDeps {
  requireSession: RequireSession;
  start: StartDraftRun;
}

export interface DraftRunOutcome {
  /** The run this submission stands for — the first one's id when it is a repeat. */
  runId?: string;
  /** Set when nothing was started. Bounded text, never an error's stack. */
  error?: string;
}

export async function startDraftRunFromForm(
  deps: DraftRunDeps,
  formData: FormData,
): Promise<DraftRunOutcome> {
  // Before the input is even looked at: what a refusal says must not depend on what was typed.
  await deps.requireSession({ factor: "passkey", role: ADMIN_ROLE });

  const minScore = numberOf(formData, DRAFT_MIN_SCORE_FIELD);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) return { error: NOT_A_SCORE };

  const limit = numberOf(formData, DRAFT_LIMIT_FIELD);
  if (!Number.isInteger(limit) || limit < 1 || limit > DRAFT_LIMIT_MAX) return { error: NOT_A_LIMIT };

  const runId = runIdOf(formData);
  try {
    const started = await deps.start({ minScore, limit }, { runId });
    return { runId: started.runId };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { runId };
  }
}

/** `Number("")` is 0, which would silently mean "every record": a blank field is a mistake. */
function numberOf(formData: FormData, field: string): number {
  const typed = String(formData.get(field) ?? "").trim();
  return typed === "" ? Number.NaN : Number(typed);
}

/** A submission that carried no usable key still runs; it just has no replay window of its own. */
function runIdOf(formData: FormData): string {
  const key = String(formData.get(DRAFT_RUN_KEY_FIELD) ?? "").trim();
  return `${RUN_ID_PREFIX}${KEY_PATTERN.test(key) ? key : randomUUID()}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
