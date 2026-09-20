import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftRunForm, type DraftRunFormProps } from "../app/(admin)/admin/[[...path]]/draft-run";
import { DRAFT_RUN_KEY_FIELD } from "../app/(admin)/admin/[[...path]]/draft-run-form";

/**
 * The draft-outreach form's markup, without a database, a browser or a server.
 *
 * Three claims: the two numbers arrive with the defaults an owner should not have to think
 * about, the key the run's id is derived from is in the form before any JavaScript runs, and a
 * started run is named next to the inbox it fills. The fourth is the budget form's — the
 * `?draftError=` a refusal comes back as is a query parameter, so it is the one value on this
 * page a stranger can choose.
 */
const INJECTION = '<img src=x onerror="alert(1)">';

function render(overrides: Partial<DraftRunFormProps> = {}): string {
  return renderToStaticMarkup(
    <DraftRunForm keySeed="seed-0000-key" action={() => undefined} {...overrides} />,
  );
}

describe("the draft-outreach form", () => {
  it("offers the two numbers with their defaults", () => {
    const html = render();

    expect(html).toContain("Draft outreach for the top scored notes");
    expect(html).toContain('name="minScore"');
    expect(html).toContain('value="0.5"');
    expect(html).toContain('name="limit"');
    expect(html).toContain('max="10"');
    expect(html).toContain('value="2"');
  });

  /**
   * `run-key.tsx` spells its field name out rather than importing it, because a client module
   * importing the form module would pull the session guard into the browser bundle. This is what
   * keeps the two spellings the same one.
   */
  it("carries the server render's replay key, so a form without JavaScript has one", () => {
    expect(render()).toContain(
      `type="hidden" name="${DRAFT_RUN_KEY_FIELD}" value="seed-0000-key"`,
    );
  });

  it("names the run it started, and the inbox its approvals land in", () => {
    const html = render({ startedRunId: "admin-draft-abc" });

    expect(html).toContain("Started run admin-draft-abc");
    expect(html).toContain('href="/w/approvals"');
  });

  it("renders a refusal as text, and none when there is none", () => {
    expect(render()).not.toContain('role="alert"');

    const html = render({ error: `Not a score: ${INJECTION}` });

    expect(html).toContain('role="alert"');
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;img src=x");
  });
});
