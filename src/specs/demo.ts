import { defineSpec } from "@hyperfixation/core";

/** What `demoFit` judges a note against. The scorer hands this to the model verbatim. */
export interface DemoFitCriteria {
  /** Plain prose, because it ends up in a prompt. */
  wants: string;
  avoid: string;
  /** The shape of the answer, stated to the model and enforced by the scorer's schema. */
  scale: string;
}

/**
 * The spec: the criteria a score was assigned under, versioned.
 *
 * Every `hf_score` row and the record's own `spec_version` column carry this number, so a score
 * is always readable against the criteria that produced it. Bump `version` whenever `criteria`
 * changes meaning — a new version adds rows and rewrites nothing, which is what makes "the model
 * got stricter in March" a query rather than a memory.
 */
export const demoFitSpec = defineSpec<DemoFitCriteria>({
  name: "demoFit",
  version: 1,
  criteria: {
    wants: "a business that keeps its own premises and would plausibly reply to a first email",
    avoid: "a directory listing, an aggregator, or anything with no named contact",
    scale: "0 for no fit at all, 1 for an obvious fit",
  },
});
