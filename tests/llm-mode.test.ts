import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * What the worker's boot records as `/api/status`'s `llm.mode`: `fixtures` on a machine with no
 * provider key, `live` once one is set. The decision is entirely `src/llm.ts`'s — `worker.ts` adds
 * only the pool — so this spawns that boot rather than `startWorker()`, which is
 * `contract.test.ts`'s subject.
 *
 * One process per case, and why, is `llm-mode-boot.ts`'s comment.
 */
const BOOT = fileURLToPath(new URL("./llm-mode-boot.ts", import.meta.url));
const run = promisify(execFile);

/** The child's environment with both keys cleared, so a developer's `.env` cannot decide a case. */
function envWithout(keys: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...keys };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (!(key in keys)) delete env[key];
  }
  return env;
}

async function boot(keys?: Record<string, string>, ...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ["--import", "tsx", BOOT, ...args], {
    cwd: process.cwd(),
    env: envWithout(keys),
  });
  return stdout;
}

describe("the LLM mode the worker's boot records", () => {
  it("is fixtures when no provider key is set", async () => {
    expect(await boot()).toContain("hf-test-mode fixtures");
  });

  it("is live when a provider key is set", async () => {
    expect(await boot({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" })).toContain("hf-test-mode live");
  });

  it("does not fail the boot when the write fails", async () => {
    // Exit 0 is the assertion: `execFile` rejects on a non-zero exit, and the line after the write
    // is what proves the boot carried on rather than merely not throwing.
    expect(await boot(undefined, "fail")).toContain("hf-test-boot-finished");
  });
});
