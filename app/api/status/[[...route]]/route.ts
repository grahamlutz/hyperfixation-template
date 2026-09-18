import { attachedApp } from "@/web";

/**
 * `GET /api/status` under the read token; `POST /api/status/{pause,resume}` under the write
 * token. Core owns all three — the token comparison, the refusal shape, the report — so this
 * file is the mount point and nothing else.
 *
 * A catch-all rather than a plain `route.ts`: pause and resume are suffixes of the same mount,
 * and `statusRouteOf()` matches on the suffix precisely so an app can mount them anywhere.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return (await attachedApp()).statusHandler(request);
}

export async function POST(request: Request): Promise<Response> {
  return (await attachedApp()).statusHandler(request);
}
