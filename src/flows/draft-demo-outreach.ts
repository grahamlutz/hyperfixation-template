import { actions, defineFlow, step, waitForApproval, type StepContext } from "@hyperfixation/workflows";
import { sql } from "drizzle-orm";
import { prettifyError } from "zod";
import { DEMO_DRAFT_TYPE, demoDraftSchema, type DemoDraft } from "../approvals/demo-draft";
import { emailChannel, type EmailRequest } from "../channels/email";
import { llm } from "../llm";

export interface DraftDemoOutreachInput {
  /** Only a record the scorer liked this much is written to. */
  minScore?: number;
  /** A cap per run, so one run cannot queue a hundred approvals at a human. */
  limit?: number;
}

/** The columns the flow reads; `id` is text, as a `bigint` is. */
type DraftTarget = {
  id: string;
  normalized_name: string;
  body: string;
  contact_email: string;
};

export const DRAFT_DEMO_OUTREACH = "draftDemoOutreach";

const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_LIMIT = 10;

/** Derived rather than imported: `@ai-sdk/provider`'s `JSONSchema7` is not this app's dependency. */
type LlmSchema = NonNullable<Parameters<typeof llm.run>[1]["schema"]>;

const DRAFT_SCHEMA: LlmSchema = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

/**
 * The loop's fourth step, and the only one that reaches outside: a draft, a human, a send.
 *
 * Read it as the three things a flow does that nothing before it did.
 *
 * **It stops.** `waitForApproval` writes `hf_approval`, concludes the run `waiting` and throws;
 * the run has no worker and no timer of its own until `approvals.decide` bumps its attempt and
 * enqueues the next one. That attempt re-runs this flow **from the top** — the select, the draft,
 * every record before this one — which is why each of those is keyed and why the draft's ledger
 * key is the record's id. Everything before a gate runs again on the other side of it.
 *
 * **It sends on a channel that cannot dedupe.** `emailChannel.dedupes` is false, so a send left
 * in flight by an attempt that is gone is never repeated: `actions.perform` moves the row to
 * `uncertain`, opens a task asking a human whether the first one went out, and throws
 * `ActionUncertain`, which fails the run. That is the intended outcome, not a bug to catch — a
 * second email behind the human's back is the thing being prevented.
 *
 * **It validates its own output.** `demoDraftSchema` is the approval type's schema, and the model
 * is held to it before a human sees the draft, not only after they edit it. A draft that fails
 * leaves an activity row naming why and the record is skipped.
 *
 * Nothing schedules this flow. The three collect/resolve/score schedules converge — running them
 * again finds nothing new to do — and this one does not: a second run over the same record drafts
 * a second email and asks a second time. It is started for a record a human, the record page or
 * the exit bar asks about.
 */
export const draftDemoOutreachFlow = defineFlow<DraftDemoOutreachInput, void>(
  DRAFT_DEMO_OUTREACH,
  async (input) => {
    const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
    const limit = input.limit ?? DEFAULT_LIMIT;

    const targets = await step(
      "select",
      async (ctx) =>
        ctx.tx(async (db) => {
          const { rows } = await db.execute<DraftTarget>(sql`
            SELECT id::text AS id, normalized_name, body, contact_email
            FROM demo_note
            WHERE score >= ${minScore} AND contact_email IS NOT NULL AND archived_at IS NULL
            ORDER BY score DESC, id
            LIMIT ${limit}
          `);
          return rows;
        }),
      { key: "select" },
    );

    for (const target of targets) {
      const draft = await step("draft", (ctx) => propose(ctx, target), {
        key: `draft:${target.id}`,
      });
      if (draft === null) continue;

      const decision = await waitForApproval({
        key: `approve:${target.id}`,
        type: DEMO_DRAFT_TYPE,
        draft,
        recordType: "demoNote",
        recordId: target.id,
      });

      await step(
        "send",
        async (ctx) => {
          const { app } = await import("../hyperfixation");
          if (decision.status !== "approved") {
            await app.activity.record(ctx, {
              recordType: "demoNote",
              recordId: target.id,
              kind: "outreach.declined",
              body: `${decision.status} by ${decision.decidedBy ?? "nobody"}`,
              key: `send:${target.id}:declined`,
            });
            return;
          }
          // The edited draft, parsed again rather than trusted: `decide()` already held it to
          // this schema, and the row it wrote is still a jsonb column a migration or a hand-run
          // `UPDATE` can reach. The parse is what makes `approved` a `DemoDraft` here.
          const approved = demoDraftSchema.parse(decision.draft);
          const request: EmailRequest = {
            to: approved.to,
            subject: approved.subject,
            text: approved.body,
          };
          const sent = await actions.perform(ctx, {
            key: `send:${target.id}`,
            channel: emailChannel,
            request,
            recordType: "demoNote",
            recordId: target.id,
          });
          await app.tasks.create(ctx, {
            recordType: "demoNote",
            recordId: target.id,
            title: `Follow up with ${target.normalized_name} if there is no reply`,
            key: `send:${target.id}`,
          });
          await app.activity.record(ctx, {
            recordType: "demoNote",
            recordId: target.id,
            kind: "outreach.sent",
            body: approved.subject,
            meta: { approvalId: decision.approvalId, externalId: sent.externalId },
            key: `send:${target.id}`,
          });
        },
        { key: `send:${target.id}` },
      );
    }
  },
  { queue: "actions" },
);

/**
 * One draft, ledgered under the record's id so the attempt that resumes past the approval replays
 * the answer instead of paying for it again.
 *
 * Null is the skip: a draft that does not parse is the model failing an app rule, which is a
 * fact about the record worth a timeline row, not a reason to fail the run and re-draft every
 * other record on the next attempt.
 */
async function propose(ctx: StepContext, target: DraftTarget): Promise<DemoDraft | null> {
  const answer = await llm.run<{ subject: string; body: string }>(ctx, {
    key: `draft:${target.id}`,
    model: "claude-haiku-4-5",
    prompt: "draft",
    input: { name: target.normalized_name, body: target.body },
    schema: DRAFT_SCHEMA,
  });

  const parsed = demoDraftSchema.safeParse({ to: target.contact_email, ...answer });
  if (parsed.success) return parsed.data;

  const { app } = await import("../hyperfixation");
  await app.activity.record(ctx, {
    recordType: "demoNote",
    recordId: target.id,
    kind: "draft.refused",
    body: prettifyError(parsed.error),
    key: `draft:${target.id}:refused`,
  });
  return null;
}
