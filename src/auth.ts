import {
  createAuth,
  createSessionGuard,
  type AuthSession,
  type HyperfixationAuth,
  type RequireSession,
  type SessionFactor,
} from "@hyperfixation/auth";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireEnv } from "./env";
import { sendVerificationOTP } from "./email";
import { pool } from "./web";

/**
 * better-auth, and the guard every route and server action in this app goes through.
 *
 * The factory is core's; what is per-app is the four things it cannot know — the pool, where a
 * code goes, the public origin, and the signing secret — plus the host half of the guard, which
 * is `redirect()` and `notFound()` because this app is a Next app. Both are built lazily: a
 * module-level `createAuth()` would read the environment during `next build`, which imports
 * every route module with no environment at all. `src/web.ts` defers its pool for the same
 * reason and this shares that pool, so better-auth and the control plane stay inside the one
 * five-connection web budget.
 */
let instance: HyperfixationAuth | undefined;

export function auth(): HyperfixationAuth {
  const appUrl = requireEnv("APP_URL");
  instance ??= createAuth({
    pool: pool(),
    sendVerificationOTP,
    baseURL: appUrl,
    secret: requireEnv("BETTER_AUTH_SECRET"),
    trustedOrigins: [appUrl],
    // The relying party is the app's own origin. A passkey enrolled against one `rpID` is
    // unusable against another, so this must be the deployed host and not a convenience value.
    rpID: new URL(appUrl).hostname,
    rpName: appUrl,
    origin: appUrl,
  });
  return instance;
}

/**
 * better-auth's session is a superset of what the policy reads; this is the narrowing, field by
 * field rather than by spread. `role` and `banned` are optional on better-auth's user and
 * nullable on the policy's, and under `exactOptionalPropertyTypes` those are not the same type —
 * which is the useful kind of friction, because "absent" and "not banned" must not be a
 * distinction the guard can trip over.
 */
async function currentSession(): Promise<AuthSession | null> {
  const result = await auth().api.getSession({ headers: await headers() });
  if (result === null) return null;
  const { id, email, role, banned } = result.user;
  return {
    factor: result.session.factor as SessionFactor,
    user: { id, email, role: role ?? null, banned: banned ?? null },
  };
}

/**
 * `requireSession({ factor, role })` for layouts, server actions and route handlers.
 *
 * The refusals divert through Next's own control flow, both of which throw — so `AccessRefused`
 * is unreachable here and a route that forgets to handle a refusal cannot render anyway. Which
 * of the two a refusal gets is the policy's decision, not this file's: anything that names a
 * role answers `notFound()`, because the existence of `/admin` is not a stranger's to learn.
 */
export const requireSession: RequireSession = createSessionGuard({
  getSession: currentSession,
  onRedirect: (to) => {
    redirect(to);
  },
  onNotFound: () => {
    notFound();
  },
});
