import { defineScorer, type Scored } from "@hyperfixation/core";
import type { StepContext } from "@hyperfixation/workflows";
import { llm } from "../llm";
import { demoFitSpec, type DemoFitCriteria } from "../specs/demo";

/**
 * The columns the scoring flow reads and hands the scorer; `id` is text, as a `bigint` is.
 * A type rather than an interface: `db.execute<R>` constrains `R` to `Record<string, unknown>`.
 */
export type DemoNoteRecord = {
  id: string;
  normalized_name: string;
  body: string;
  contact_email: string | null;
};

export const DEMO_SCORER_NAME = "demoFit";

/** Derived rather than imported: `@ai-sdk/provider`'s `JSONSchema7` is not this app's dependency. */
type LlmSchema = NonNullable<Parameters<typeof llm.run>[1]["schema"]>;

const SCORE_SCHEMA: LlmSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string" },
  },
  required: ["score", "explanation"],
  additionalProperties: false,
};

/**
 * The scorer: one record, one spec, one `Scored`.
 *
 * `ctx` is the step's, and it is what makes the call ledgered — `llm.run` writes `hf_llm_call`
 * through `ctx.tx` and keys the row `score:<record id>`, so a second attempt of the same run
 * returns the first attempt's answer instead of paying for it again. The key is the record's id
 * rather than the step's so that it survives a flow that scores the same record from two places.
 *
 * With no provider key set the answer comes from `fixtures/llm/score.json`, chosen by the
 * business name in the input — which is how `pnpm test` and CI run this without a key.
 */
export const demoScorer = defineScorer<DemoNoteRecord, DemoFitCriteria>({
  name: DEMO_SCORER_NAME,
  recordType: "demoNote",
  spec: demoFitSpec,
  async score(record, criteria, ctx: StepContext): Promise<Scored> {
    const answer = await llm.run<{ score: number; explanation: string }>(ctx, {
      key: `score:${record.id}`,
      model: "claude-haiku-4-5",
      prompt: "score",
      input: {
        name: record.normalized_name,
        body: record.body,
        contactEmail: record.contact_email,
        criteria,
      },
      schema: SCORE_SCHEMA,
    });
    return { score: answer.score, explanation: answer.explanation };
  },
});
