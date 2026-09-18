import type { ReactNode } from "react";

/**
 * The auth area's shell. It calls no guard, and that is the policy rather than an omission:
 * `/auth/*` is where a session that does not exist yet, and a code-factor one that cannot go
 * anywhere else, are both allowed to be.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main style={{ maxWidth: "24rem", margin: "4rem auto", padding: "0 1.5rem" }}>{children}</main>
  );
}
