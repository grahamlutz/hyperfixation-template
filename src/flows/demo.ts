import { defineFlow, step } from "@hyperfixation/workflows";
import { sql } from "drizzle-orm";

export interface DemoNoteInput {
  /** What the resolver would match on; unique per note in the demo. */
  normalizedName: string;
  body: string;
}

export const DEMO_FLOW_NAME = "recordDemoNote";
export const DEMO_STEP_KEY = "record";

/**
 * The one flow the template ships, and the shape `tests/flow-restart.test.ts` holds every flow
 * to: its single step is keyed, its write goes through `ctx.tx` (the only handle a step body
 * gets), and the write is an upsert on a natural key rather than a plain `INSERT` — so a
 * second attempt of the same run, which is what every redeploy produces, converges instead of
 * duplicating.
 *
 * `.claude/skills/replace-demo/` replaces it.
 */
export const demoFlow = defineFlow<DemoNoteInput, void>(
  DEMO_FLOW_NAME,
  async (input) => {
    await step(
      "record",
      async (ctx) => {
        await ctx.tx(async (db) => {
          await db.execute(sql`
            INSERT INTO demo_note (normalized_name, body)
            VALUES (${input.normalizedName}, ${input.body})
            ON CONFLICT (normalized_name) DO UPDATE SET body = EXCLUDED.body
          `);
        });
      },
      { key: DEMO_STEP_KEY },
    );
  },
  { queue: "resolve" },
);
