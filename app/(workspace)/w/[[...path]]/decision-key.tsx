"use client";
import { useEffect, useState } from "react";

/**
 * The batch's replay token, minted in the browser once per mount.
 *
 * `decide()` treats a second call carrying a key already on its rows as a replay: it writes
 * nothing and returns what the first one did. That is only worth anything if a double click,
 * a reloaded POST or a flaky connection sends the *same* key twice — so the key belongs to the
 * form the human is looking at, not to the request, and `useState` is what pins it there.
 *
 * `seed` is the server render's own token. It fills the field before hydration and with
 * JavaScript off, and the browser's own `randomUUID` replaces it on mount through a state
 * update, which is not a hydration mismatch. A mount that outlives a decision keeps its key,
 * and that is harmless: a decided approval leaves the inbox, so the next batch is all rows the
 * key has never been written to.
 */
export function DecisionKey({ seed }: { seed: string }) {
  const [key, setKey] = useState(seed);
  useEffect(() => {
    setKey(crypto.randomUUID());
  }, []);
  return <input type="hidden" name="decisionKey" value={key} />;
}
