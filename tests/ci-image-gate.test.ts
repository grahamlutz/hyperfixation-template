import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TEMPLATE_MARKER } from "@hyperfixation/cli";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * `hf new` copies this repo and deletes only `TEMPLATE_MARKER`, so every generated app inherits
 * this workflow — and with it the `image` job, whose `test:prod` suites generate an app out of a
 * template checkout and so throw `is not a template checkout` anywhere else. That made CI
 * permanently red in the first generated app, which in turn meant a `core-bump/*` PR there could
 * never be all-green: the thing the rule "merge a bump only when green" is about.
 *
 * So: every step that runs one of those suites carries the marker condition, and the steps that
 * assert the image itself carry none — a generated app still builds its Dockerfile and still
 * answers which commit it is.
 */

interface Step {
  name?: string;
  if?: string;
  run?: string;
}

const workflow = parse(
  readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8"),
) as { jobs: { image: { if?: string; steps: Step[] } } };

const image = workflow.jobs.image;
const GATE = `hashFiles('${TEMPLATE_MARKER}') != ''`;

describe("ci.yml's image job", () => {
  it("runs in a generated app rather than skipping itself", () => {
    // A job-level `if` would report `image` as skipped, which a ruleset requiring it reads as
    // passing — the required check has to be a real one in the template.
    expect(image.if).toBeUndefined();
  });

  it("gates every template-only step on the marker", () => {
    const templateOnly = image.steps.filter((step) => step.run?.includes("tests/e2e/prod-"));

    expect(templateOnly.length).toBeGreaterThan(0);
    for (const step of templateOnly) {
      expect(step.if, `${step.name ?? step.run} runs unconditionally`).toBe(GATE);
    }
  });

  it("builds the image and asserts its commit unconditionally", () => {
    const ungated = image.steps.filter((step) => step.if === undefined);

    expect(ungated.filter((step) => step.run?.startsWith("docker build"))).toHaveLength(2);
    expect(ungated.filter((step) => step.run?.includes("HF_BUILD_SHA"))).toHaveLength(2);
  });
});
