import hyperfixation, { BANNED_MEMBER } from "@hyperfixation/eslint-config";

/**
 * The shared config, plus one ban of this repo's own. Its three — the `DBOS` primitives that
 * would carry a workflow across a version boundary, deep imports into a package's `src/`/`dist/`,
 * and the raw database handle in `src/flows/**` — are the same rules core is held to, because an
 * app that breaks one breaks the run model in exactly the same way.
 *
 * The fourth is the workspace's: every value it renders is model output or a row a run wrote, and
 * React escapes all of it. `dangerouslySetInnerHTML` is the one way to undo that, so it is a lint
 * error rather than something a reviewer has to notice. The block repeats the shared config's
 * `sendInTransaction` selector because `no-restricted-syntax` replaces rather than merges.
 */
export default [
  ...hyperfixation,
  {
    name: "app/workspace-escaping",
    files: ["app/(workspace)/**/*.ts", "app/(workspace)/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            "The workspace renders model output. React escapes it; dangerouslySetInnerHTML does not.",
        },
        {
          selector: `MemberExpression[property.name="${BANNED_MEMBER}"]`,
          message: `${BANNED_MEMBER} is banned: no core table has an FK to a DBOS row, and a collected workflow row would silently discard the committed decision.`,
        },
      ],
    },
  },
  { ignores: [".next/**", "dist/**", "drizzle/**"] },
];
