import { defineFlow, step } from "@hyperfixation/workflows";

export interface ResolveDemoSourceInput {
  resolver: string;
  source: string;
}

export const RESOLVE_DEMO_SOURCE = "resolveDemoSource";

/**
 * The second half: every unlinked row of the source linked to a record, or parked.
 *
 * One step is one batch and one transaction, and the flow loops until a batch reports `done`.
 * The alternative — the whole load in one transaction — holds `hf_run FOR SHARE` for as long as
 * resolution takes, which on a two-hundred-thousand-row source is the rest of the deploy.
 *
 * `resolve:<n>` keys the batches by position, so a restarted attempt re-runs batch 0 as batch 0.
 * It re-does the work rather than skipping it, and that is safe because the scan only ever sees
 * rows that are not yet `linked`: a batch whose transaction committed has nothing left to find.
 */
const MAX_BATCHES = 1_000;

export const resolveDemoSourceFlow = defineFlow<ResolveDemoSourceInput, void>(
  RESOLVE_DEMO_SOURCE,
  async (input) => {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await step(
        "resolve",
        async (ctx) => {
          const { app } = await import("../hyperfixation");
          return ctx.tx((db) =>
            app.resolution.batch(db, { resolver: input.resolver, source: input.source }),
          );
        },
        { key: `resolve:${batch}` },
      );
      if (result.done) return;
    }
    // Not a timeout dressed up as a cap: a batch that fills its `limit` entirely with rows it
    // sends to `review` leaves them unlinked and scannable, so without this the loop never ends.
    throw new Error(
      `${RESOLVE_DEMO_SOURCE}: ${input.source} was still not resolved after ` +
        `${MAX_BATCHES} batches`,
    );
  },
  { queue: "resolve" },
);
