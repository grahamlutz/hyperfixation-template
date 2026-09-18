import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The runner stage copies `.next/standalone`; without this there is nothing to copy.
  output: "standalone",
  // Left to Node's own resolver rather than bundled. All of them are server-only and reach
  // native bindings (`pg`) or a module-level singleton (`DBOS`) that must be one object per
  // process — bundling a second copy into the web would give the web a different `DBOS` than
  // the one `startWorker()` launched, and `getClient()` a second boot-check pass.
  serverExternalPackages: [
    "@dbos-inc/dbos-sdk",
    "@hyperfixation/admin",
    "@hyperfixation/ai",
    "@hyperfixation/auth",
    "@hyperfixation/core",
    "@hyperfixation/db",
    "@hyperfixation/workflows",
    "drizzle-orm",
    "pg",
  ],
};

export default nextConfig;
