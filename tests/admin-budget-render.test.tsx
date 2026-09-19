import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BudgetForm, type BudgetFormProps } from "../app/(admin)/admin/[[...path]]/budget";

/**
 * The budget form's markup, without a database, a browser or a server.
 *
 * Three claims: the period's spend and ceiling are on the page next to the input, the input is
 * a number pre-filled with what is stored rather than with a rounded copy of it, and a refusal
 * reaches the DOM as text — the `?error=` it is rendered from is a query parameter, so it is
 * the one value on this page a stranger can choose.
 */
const INJECTION = '<img src=x onerror="alert(1)">';

function render(overrides: Partial<BudgetFormProps> = {}): string {
  return renderToStaticMarkup(
    <BudgetForm
      period="2026-09"
      budgetUsd="100.0000"
      spentUsd="12.5000"
      currentPeriod
      action={() => undefined}
      {...overrides}
    />,
  );
}

describe("the budget form", () => {
  it("shows the period, what it has spent and what it may spend", () => {
    expect(render()).toContain("2026-09 — spent 12.5000 of 100.0000");
  });

  it("says whether this is the period the next gate reads", () => {
    expect(render()).toContain("This is the current period");
    expect(render({ currentPeriod: false })).toContain("not the current period");
  });

  it("offers a number input carrying the stored budget, and the period it posts", () => {
    const html = render();

    expect(html).toContain('type="number"');
    expect(html).toContain('name="budgetUsd"');
    expect(html).toContain('value="100.0000"');
    expect(html).toContain('type="hidden" name="period" value="2026-09"');
  });

  it("renders a refusal as text, and none when there is none", () => {
    expect(render()).not.toContain("role=\"alert\"");

    const html = render({ error: `Not a budget: ${INJECTION}` });

    expect(html).toContain("role=\"alert\"");
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;img src=x");
  });
});
