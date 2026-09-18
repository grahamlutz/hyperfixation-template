import { defineApp } from "@hyperfixation/core";
import { demoFlow } from "./flows/demo";

/**
 * The app object. Registration is module-level; the handles are not.
 *
 * Both the web and `worker.ts` import this file, and only one of them has a control pool at
 * import time — so nothing here opens a connection, and each process calls `app.attach()` once
 * it knows which shape it is. `applicationVersion` comes from `HF_BUILD_SHA` by default, which
 * is the one source of a version in every process.
 *
 * `pnpm gen` appends to the arrays below; keep them one entry per line.
 */
export const app = defineApp({
  name: "__APP_NAME__",
  flows: [
    demoFlow,
  ],
  records: [
    { table: "demo_note", recordType: "demoNote" },
  ],
});

/** What `startWorker()` and `getClient()` need for boot checks E001–E003. */
export const recordTables = app.records.types.all();
