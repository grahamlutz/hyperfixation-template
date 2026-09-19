import { loadSource } from "@hyperfixation/db";
import { defineFlow, step } from "@hyperfixation/workflows";

export interface CollectDemoSourceInput {
  /** A registered source's name, so one flow serves every source an app adds. */
  source: string;
}

export const COLLECT_DEMO_SOURCE = "collectDemoSource";

/**
 * The first half of the loop's first step: everything a source yields, staged into
 * `hf_source_record`.
 *
 * One step, one transaction, one `COPY`. `loadSource` upserts on `(source, external_id)`, so
 * running this again — which is what every schedule tick and every restarted attempt does —
 * moves `last_seen` on an unchanged row and resets a changed one to `new` for resolution to pick
 * up. It decides nothing: which record a row belongs to is `resolveDemoSource`'s business, and
 * splitting the two is what lets a resolver change without re-fetching the source.
 *
 * `hf_source_run` gains a row per call by design — it is the load's own history — so it is the
 * one table a restart legitimately grows, and `tests/flow-restart.test.ts` does not count it.
 */
export const collectDemoSourceFlow = defineFlow<CollectDemoSourceInput, void>(
  COLLECT_DEMO_SOURCE,
  async (input) => {
    await step(
      "load",
      async (ctx) => {
        // Imported here, not at the top: `src/hyperfixation.ts` imports this module to register
        // the flow, so a top-level import of it would be an evaluation cycle.
        const { app } = await import("../hyperfixation");
        const source = app.sources.require(input.source);
        await ctx.tx(async (db) => {
          await loadSource(db, source.name, source.fetch());
        });
      },
      { key: "load" },
    );
  },
  { queue: "resolve" },
);
