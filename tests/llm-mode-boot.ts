/**
 * `src/llm.ts`'s boot, in a process of its own — what `llm-mode.test.ts` spawns once per case.
 *
 * It cannot be an in-process import: the mode is module state inside `@hyperfixation/ai`, set when
 * the registry is built and never downgraded from `fixtures` back to `live`, and vitest's
 * `resetModules()` does not reach a dependency Node loaded itself. Two answers, two processes.
 *
 * The pool is a stub rather than a database: what is under test is which mode the boot hands to
 * the write, and `contract.test.ts` is where a real `hf_app_state` row is asserted. `fail` makes
 * the write reject, for the case that a worker must survive it.
 */
import { reportLlmMode } from "../src/llm";

const shouldFail = process.argv[2] === "fail";

const pool = {
  query: (_text: string, params: unknown[]) => {
    // The parent greps for this line; a `console.error` from the swallowed failure is noise beside it.
    console.log(`hf-test-mode ${String(params[0])}`);
    return shouldFail ? Promise.reject(new Error("hf_app_state is not there yet")) : Promise.resolve({ rows: [] });
  },
};

await reportLlmMode(pool as never);
console.log("hf-test-boot-finished");
