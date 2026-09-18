import hyperfixation from "@hyperfixation/eslint-config";

/**
 * The shared config and nothing else. Its three bans — the `DBOS` primitives that would carry
 * a workflow across a version boundary, deep imports into a package's `src/`/`dist/`, and the
 * raw database handle in `src/flows/**` — are the same rules core is held to, because an app
 * that breaks one breaks the run model in exactly the same way.
 */
export default [...hyperfixation, { ignores: [".next/**", "dist/**", "drizzle/**"] }];
