import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16's request proxy (what earlier versions called middleware).
 *
 * It deliberately enforces nothing. The session-factor policy — code sessions confined to
 * `/auth/*`, `/admin/*` requiring the `admin` role and 404ing otherwise — runs in both layouts
 * and in every server action and route handler through `requireSession({ factor, role })`. A
 * proxy sees a cookie, not a session, so a guard here would be a second, weaker answer to a
 * question the server components already answer authoritatively. What it is for is the cheap
 * cross-cutting work that has no session in it: request ids, locale, host canonicalisation.
 */
export function proxy(_request: NextRequest): NextResponse {
  return NextResponse.next();
}

export const config = {
  matcher: ["/w/:path*", "/admin/:path*"],
};
