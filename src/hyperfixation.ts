import { defineApp, defineSchedule } from "@hyperfixation/core";
import { demoDraftApproval } from "./approvals/demo-draft";
import { emailChannel } from "./channels/email";
import { demoResolver } from "./resolvers/demo";
import { demoScorer } from "./scorers/demo";
import { DEMO_SOURCE_NAME, demoSource } from "./sources/demo";
import { demoFitSpec } from "./specs/demo";
// `pnpm gen` appends a new flow's import directly below this line; keep the flow imports last.
import { collectDemoSourceFlow } from "./flows/collect-demo-source";
import { resolveDemoSourceFlow } from "./flows/resolve-demo-source";
import { scoreDemoNotesFlow } from "./flows/score-demo-notes";
import { draftDemoOutreachFlow } from "./flows/draft-demo-outreach";

/** How often `worker.ts` fires each of the three schedules below. */
export const SCHEDULE_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * The app object. Registration is module-level; the handles are not.
 *
 * Both the web and `worker.ts` import this file, and only one of them has a control pool at
 * import time — so nothing here opens a connection, and each process calls `app.attach()` once
 * it knows which shape it is. `applicationVersion` comes from `HF_BUILD_SHA` by default, which
 * is the one source of a version in every process.
 *
 * The flows are listed in the order the loop runs them — collect, resolve, score, draft — because
 * that is the order `tests/flow-restart.test.ts` runs them in, and the demo's fixtures chain: the
 * rows `collectDemoSource` stages are what `resolveDemoSource` turns into `demo_note` records,
 * those are what `scoreDemoNotes` finds to score, and the scores are what `draftDemoOutreach`
 * picks a record to write to by. Only the first three are scheduled; the draft flow asks a human
 * and is started for a record, not on a clock.
 *
 * `pnpm gen` appends to the arrays below; keep them one entry per line.
 */
export const app = defineApp({
  name: "__APP_NAME__",
  flows: [
    collectDemoSourceFlow,
    resolveDemoSourceFlow,
    scoreDemoNotesFlow,
    draftDemoOutreachFlow,
  ],
  records: [
    { table: "demo_note", recordType: "demoNote" },
  ],
  sources: [demoSource],
  resolvers: [demoResolver],
  specs: [demoFitSpec],
  scorers: [demoScorer],
  approvalTypes: [demoDraftApproval],
  channels: [emailChannel],
  // Each schedule's `input()` is built per firing, and names its registration rather than holding
  // it: one flow per stage serves every source or scorer the app goes on to add.
  schedules: [
    defineSchedule({
      name: "collect",
      flow: collectDemoSourceFlow,
      every: SCHEDULE_INTERVAL_MS,
      input: () => ({ source: DEMO_SOURCE_NAME }),
    }),
    defineSchedule({
      name: "resolve",
      flow: resolveDemoSourceFlow,
      every: SCHEDULE_INTERVAL_MS,
      input: () => ({ resolver: demoResolver.name, source: DEMO_SOURCE_NAME }),
    }),
    defineSchedule({
      name: "score",
      flow: scoreDemoNotesFlow,
      every: SCHEDULE_INTERVAL_MS,
      input: () => ({ scorer: demoScorer.name }),
    }),
  ],
});

/** What `startWorker()` and `getClient()` need for boot checks E001–E003. */
export const recordTables = app.records.types.all();
