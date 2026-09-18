import { auth } from "@/auth";

/**
 * better-auth's whole handler, mounted. Sign-in, the emailed code, and both WebAuthn
 * ceremonies are its endpoints and not this app's.
 *
 * It is deliberately **not** guarded by `requireSession()`. It is the one surface an
 * unauthenticated request must reach — there is no way to sign in through a route that
 * requires a session — and `routeAreaOf()` puts `/api/auth/*` in the auth area for the
 * complementary reason: a code-factor session has to be able to drive `/passkey/register`
 * in order to enrol the passkey that promotes it.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return auth().handler(request);
}
