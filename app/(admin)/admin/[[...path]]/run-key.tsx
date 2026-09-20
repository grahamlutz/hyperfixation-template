"use client";
import { useEffect, useState } from "react";

/**
 * The submission's replay token, minted in the browser once per mount — the inbox's
 * `decision-key.tsx`, for a run instead of a batch.
 *
 * The key is what the run's id is derived from, so a double click, a reloaded POST or a flaky
 * connection carrying the *same* key gets the run the first one started rather than a second
 * one drafting the same emails again. `seed` is the server render's own token, which fills the
 * field before hydration and with JavaScript off.
 *
 * The field's name is spelled out rather than imported from `draft-run-form.ts`, as
 * `decision-key.tsx` spells out its own: a client module importing that one would pull the
 * session guard — and through it `@dbos-inc/dbos-sdk` — into the browser bundle, and the build
 * fails on the first Node-only import it cannot resolve there.
 */
export function RunKey({ seed }: { seed: string }) {
  const [key, setKey] = useState(seed);
  useEffect(() => {
    setKey(crypto.randomUUID());
  }, []);
  return <input type="hidden" name="runKey" value={key} />;
}
