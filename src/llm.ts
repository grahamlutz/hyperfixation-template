import path from "node:path";
import { createLlm, createProviders } from "@hyperfixation/ai";

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
