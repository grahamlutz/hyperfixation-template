import { defineFlow, step } from "@hyperfixation/workflows";
import { sql } from "drizzle-orm";
import type { DemoNoteRecord } from "../scorers/demo";

export interface ScoreDemoNotesInput {
  scorer: string;
  /** A cap per run, so one tick of the schedule cannot spend the month's budget. */
  limit?: number;
}

export const SCORE_DEMO_NOTES = "scoreDemoNotes";

const DEFAULT_LIMIT = 50;

/**
 * The third step of the loop: every unscored record gets a score and an explanation.
 *
 * "Unscored" is `score IS NULL`, so a restarted attempt normally finds nothing left to do — but
 * the keys are what make the case that matters safe. `llm.run` ledgers under `score:<record id>`
 * and `scores.write` under the step's own key, so a run that died between a paid provider call
 * and the score's commit re-finds the record, replays the answer out of `hf_llm_call` without
 * paying twice, and writes the score once.
 */
export const scoreDemoNotesFlow = defineFlow<ScoreDemoNotesInput, void>(
  SCORE_DEMO_NOTES,
  async (input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;

    const records = await step(
      "select",
      async (ctx) =>
        ctx.tx(async (db) => {
          const { rows } = await db.execute<DemoNoteRecord>(sql`
            SELECT id::text AS id, normalized_name, body, contact_email
            FROM demo_note
            WHERE score IS NULL AND archived_at IS NULL
            ORDER BY id
            LIMIT ${limit}
          `);
          return rows;
        }),
      { key: "select" },
    );

    for (const record of records) {
      await step(
        "score",
        async (ctx) => {
          const { app } = await import("../hyperfixation");
          const scorer = app.scorers.require(input.scorer);
          const scored = await scorer.score(record, scorer.spec.criteria, ctx);
          await app.scores.write(ctx, {
            recordType: scorer.recordType,
            recordId: record.id,
            spec: scorer.spec,
            score: scored.score,
            ...(scored.explanation === undefined ? {} : { explanation: scored.explanation }),
          });
        },
        { key: `score:${record.id}` },
      );
    }
  },
  { queue: "llm" },
);
