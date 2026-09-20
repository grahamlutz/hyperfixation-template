import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The other half of the core-bump rule: every `@hyperfixation/*` package is released in
 * lockstep, so an app runs one version of all of them or it runs a combination nothing was
 * tested against. Two ways that goes wrong, and neither shows up as an import error —
 * `@hyperfixation/admin` on an older `@hyperfixation/core` type-checks against the copy it was
 * published with, and a hand-edited range drifts from the lockfile silently.
 *
 * So: every installed copy, the transitive ones included, at one version; and that version
 * inside the range `package.json` declares.
 */

const root = new URL("../", import.meta.url);
const path = (name: string): string => fileURLToPath(new URL(name, root));

const SCOPE = "@hyperfixation/";

/** `undefined` when the range is one this check does not understand — the caller fails on it. */
const rangeBound = (range: string): { min: string; max: string } | undefined => {
  const match = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return undefined;
  const [, operator, major, minor, patch] = match;
  const [x, y, z] = [Number(major), Number(minor), Number(patch)];
  const min = `${x}.${y}.${z}`;
  if (operator === "^") {
    // Caret's leading-nonzero rule, which is the whole point at 0.x: `^0.1.1` admits 0.1.2 and
    // refuses 0.2.0, where `^1.1.1` would admit 1.2.0.
    if (x > 0) return { min, max: `${x + 1}.0.0` };
    if (y > 0) return { min, max: `0.${y + 1}.0` };
    return { min, max: `0.0.${z + 1}` };
  }
  if (operator === "~") return { min, max: `${x}.${y + 1}.0` };
  return { min, max: min };
};

const compare = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const [l, r] = [left[i] ?? 0, right[i] ?? 0];
    if (l !== r) return l - r;
  }
  return 0;
};

const satisfies = (version: string, range: string): boolean => {
  const bound = rangeBound(range);
  if (!bound) throw new Error(`core-version.test.ts cannot read the range ${range}`);
  if (bound.min === bound.max) return version === bound.min;
  return compare(version, bound.min) >= 0 && compare(version, bound.max) < 0;
};

/**
 * Pure so the failure modes can be tested without an install that has them. Returns one line
 * per problem, empty when the tree is coherent.
 *
 * An installed package nothing declares is still held to the single-version rule — it is a
 * transitive copy, and a second version of it is the mixed set — but has no range to check.
 */
export const coreVersionProblems = (
  installed: Record<string, string[]>,
  declared: Record<string, string>,
): string[] => {
  const problems: string[] = [];
  for (const [name, versions] of Object.entries(installed).sort()) {
    const [version, ...rest] = [...new Set(versions)].sort(compare);
    if (version === undefined) continue;
    if (rest.length > 0) {
      problems.push(`${name} is installed at ${[version, ...rest].join(" and ")}`);
      continue;
    }
    const range = declared[name];
    if (range !== undefined && !satisfies(version, range)) {
      problems.push(`${name} resolves to ${version}, outside the declared ${range}`);
    }
  }
  for (const name of Object.keys(declared).sort()) {
    if (installed[name] === undefined) problems.push(`${name} is declared but not installed`);
  }
  return problems;
};

/**
 * Every copy on disk, not just the ones the app's own `package.json` names: under pnpm's
 * isolated layout a transitive `@hyperfixation/core` lives beside its dependent in `.pnpm`,
 * which is exactly where a mixed set hides. A hoisted layout has no `.pnpm` and the top-level
 * scan is the whole of it.
 */
const readInstalled = (): Record<string, string[]> => {
  const found: Record<string, string[]> = {};
  const scan = (scopeDir: string): void => {
    if (!existsSync(scopeDir)) return;
    for (const entry of readdirSync(scopeDir)) {
      const manifest = `${scopeDir}/${entry}/package.json`;
      if (!existsSync(manifest)) continue;
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
      (found[`${SCOPE}${entry}`] ??= []).push(version);
    }
  };

  scan(path("node_modules/@hyperfixation"));
  const store = path("node_modules/.pnpm");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) scan(`${store}/${entry}/node_modules/@hyperfixation`);
  }
  return found;
};

const manifest = JSON.parse(readFileSync(path("package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const declared = Object.fromEntries(
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) =>
    name.startsWith(SCOPE),
  ),
);

describe("the installed @hyperfixation/* set", () => {
  it("declares some", () => {
    expect(Object.keys(declared).length).toBeGreaterThan(0);
  });

  it("is one version of each, inside the range package.json declares", () => {
    expect(coreVersionProblems(readInstalled(), declared)).toEqual([]);
  });
});

describe("coreVersionProblems", () => {
  const ranges = { "@hyperfixation/core": "^0.1.1", "@hyperfixation/db": "^0.1.1" };

  it("passes a coherent set", () => {
    expect(
      coreVersionProblems(
        { "@hyperfixation/core": ["0.1.2", "0.1.2"], "@hyperfixation/db": ["0.1.2"] },
        ranges,
      ),
    ).toEqual([]);
  });

  it("names a package installed at two versions", () => {
    expect(
      coreVersionProblems(
        { "@hyperfixation/core": ["0.1.1", "0.2.0"], "@hyperfixation/db": ["0.1.1"] },
        ranges,
      ),
    ).toEqual(["@hyperfixation/core is installed at 0.1.1 and 0.2.0"]);
  });

  it("names a version outside the declared range", () => {
    expect(
      coreVersionProblems(
        { "@hyperfixation/core": ["0.2.0"], "@hyperfixation/db": ["0.1.1"] },
        ranges,
      ),
    ).toEqual(["@hyperfixation/core resolves to 0.2.0, outside the declared ^0.1.1"]);
  });

  it("names a declared package that is not installed", () => {
    expect(coreVersionProblems({ "@hyperfixation/core": ["0.1.1"] }, ranges)).toEqual([
      "@hyperfixation/db is declared but not installed",
    ]);
  });

  it("holds an undeclared transitive copy to the single-version rule and no range", () => {
    expect(
      coreVersionProblems(
        {
          "@hyperfixation/core": ["0.1.1"],
          "@hyperfixation/db": ["0.1.1"],
          "@hyperfixation/testing": ["9.9.9"],
        },
        ranges,
      ),
    ).toEqual([]);
  });

  it("refuses a range it cannot read rather than passing it", () => {
    expect(() =>
      coreVersionProblems({ "@hyperfixation/core": ["0.1.1"] }, { "@hyperfixation/core": ">=0.1" }),
    ).toThrow(/cannot read the range/);
  });
});
