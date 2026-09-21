"use server";
import { upgradeSessionFactor } from "@hyperfixation/auth";
import { headers } from "next/headers";
import { auth, requireSession } from "@/auth";
import { pool } from "@/pool";

/**
 * Promotes the session that just enrolled a passkey, so enrolling and then being sent back
 * through the emailed code is not the shape of a first sign-in.
 *
 * `factor: 'code'` is the deliberate opt-down the policy describes: a server action that states
 * no factor is passkey-only, and this one is reachable only from `/auth/passkey`, by a session
 * that by definition does not hold the factor yet. `upgradeSessionFactor`'s own
 * `factor = 'code'` predicate is what keeps it a no-op on a session that already does.
 *
 * It takes the token from the guarded session rather than from the caller. A token argument
 * would be a way to promote somebody else's session.
 */
export async function promoteSession(): Promise<boolean> {
  await requireSession({ factor: "code" });
  const result = await auth().api.getSession({ headers: await headers() });
  if (result === null) return false;
  return upgradeSessionFactor(pool(), result.session.token);
}
