import path from "node:path";
import { createLlm, createProviders, reportProvidersMode } from "@hyperfixation/ai";
import type { Pool } from "pg";

/**
 * The app's one `llm.run`. A flow names a model string and a prompt file; nothing in a flow
 * holds a provider object or a dollar figure.
 *
 * The keys are read with `process.env`, never `requireEnv`: `src/hyperfixation.ts` is imported
 * with an empty environment by `hf check`'s registry probe and by `next build`, and a throw at
 * import time there is a failed check rather than a missing key. An empty key is no key, which
 * is exactly what makes `createProviders` fall back to `fixtures/llm/` — so `pnpm test` and a
 * laptop with no `ANTHROPIC_API_KEY` run the whole loop against canned answers, billing zero
 * tokens. It is all-or-nothing on purpose: configure one provider and a model that needs the
 * other still throws `UnknownModel` rather than quietly serving a fixture in production.
 *
 * Both directories are resolved against the working directory rather than this module, for the
 * same reason `worker.ts` resolves `drizzle/` that way: the image puts the compiled web bundle
 * somewhere else and `prompts/` and `fixtures/` at `/app`.
 */
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

export const llm = createLlm({
  providers: createProviders({
    ...(anthropicKey ? { anthropic: { apiKey: anthropicKey } } : {}),
    ...(openaiKey ? { openai: { apiKey: openaiKey } } : {}),
    fixtures: { dir: path.resolve(process.cwd(), "fixtures/llm") },
  }),
  promptsDir: path.resolve(process.cwd(), "prompts"),
});

/**
 * Records which of the two the registry above ended up being, where `/api/status` reads it as
 * `llm.mode`. Only `worker.ts` calls it: the registry that serves a run is the worker's, and the
 * web — which imports this module too, for routing — never makes the call it would be reporting on.
 *
 * A write that fails leaves the previous mode standing, which is a stale status line and a
 * `hf doctor` warning. That is not worth a worker refusing to serve, so this swallows.
 */
export async function reportLlmMode(pool: Pool): Promise<void> {
  try {
    await reportProvidersMode(pool);
  } catch (error) {
    console.error("hf-worker: could not record the LLM mode", error);
  }
}
