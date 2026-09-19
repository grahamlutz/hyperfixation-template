import { draftFields, type InboxItem, type InboxView } from "@hyperfixation/core/workspace";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalScreen, InboxScreen } from "../app/(workspace)/w/[[...path]]/inbox";

/**
 * The inbox's rendering, without a database, a browser or a server.
 *
 * Its first assertion is the one `workspace-render.test.tsx` makes about the record page, and
 * it matters more here: the inbox does not only *show* model output, it puts it in a text box
 * the human is invited to edit. A draft that says `<img src=x onerror=…>` has to arrive as
 * those characters in the box, and leave as them if nobody touches it.
 */
const INJECTION = '<img src=x onerror="alert(1)">';

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  const draft = {
    to: "owner@acme-roofing.example",
    subject: INJECTION,
    body: `Hello ${INJECTION}, a long enough body that the field is rendered as a text area.`,
  };
  return {
    approvalId: 12,
    runId: "run-1",
    flow: "draftDemoOutreach",
    key: "approve:7",
    type: "demoDraft",
    recordType: "demoNote",
    recordId: "7",
    recordTitle: INJECTION,
    assigneeId: null,
    createdAt: new Date("2026-09-19T10:02:00Z"),
    expiresAt: new Date("2026-09-20T10:02:00Z"),
    draft,
    fields: draftFields(draft),
    editable: true,
    ...overrides,
  };
}

function view(items: InboxItem[]): InboxView {
  return {
    items,
    mine: items.filter((each) => each.assigneeId !== null).length,
    unassigned: items.filter((each) => each.assigneeId === null).length,
  };
}

function render(items: InboxItem[], error?: string): string {
  return renderToStaticMarkup(
    <InboxScreen view={view(items)} decideAction={() => undefined} error={error} />,
  );
}

describe("the approval inbox", () => {
  it("renders a draft's markup as text in the box that edits it", () => {
    const html = render([item()]);

    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert(1)"');
    // The subject is short enough for an input and the body long enough for a text area, so
    // both spellings of "the draft reaches the DOM" are covered by this one render.
    expect(html).toContain('name="edit:12:subject"');
    expect(html).toContain("<textarea");
  });

  it("names every field for the approval it belongs to, and carries the row's id", () => {
    const html = render([item(), item({ approvalId: 13, recordId: "8" })]);

    expect(html).toContain('name="ids" value="12"');
    expect(html).toContain('name="ids" value="13"');
    expect(html).toContain('name="edit:13:body"');
    // One form, because one submission is one `decide()` call.
    expect(html.match(/<form/g)?.length).toBe(1);
    expect(html).toContain('name="decisionKey"');
  });

  it("offers no text box for an item with no registered schema", () => {
    const html = render([item({ editable: false })]);

    expect(html).not.toContain('name="edit:12:subject"');
    expect(html).toContain("registers no schema");
    // Still shown, still escaped: a read-only draft is a draft.
    expect(html).toContain("&lt;img src=x");
  });

  it("shows a field no edit could be written back to as text, not as a box", () => {
    // Two keys that flatten to the same path, and a key that walks into the prototype chain:
    // neither names a slot an edit can be written to, so neither is offered as one.
    const draft = { "a.b": "one", a: { b: "two" }, "__proto__.polluted": "three" };
    const html = render([item({ draft, fields: draftFields(draft) })]);

    expect(html).not.toContain('name="edit:12:a.b"');
    expect(html).not.toContain("__proto__");
    expect(html).toContain("one");
    expect(html).toContain("two");
  });

  it("puts a value holding a line break in a text area, whatever its length", () => {
    const draft = { subject: "short\rbreak" };
    const html = render([item({ draft, fields: draftFields(draft) })]);

    // A single-line input strips CR and LF from its value, and a stripped value posts back as
    // an edit nobody made.
    expect(html).toContain("<textarea");
    expect(html).not.toContain('type="text" name="edit:12:subject"');
  });

  it("shows a refused batch as text rather than as a failure", () => {
    const html = render([item()], "ApprovalBatchRefused: 12 recipient is not in the contact allowlist");

    expect(html).toContain('role="alert"');
    expect(html).toContain("not in the contact allowlist");
  });

  it("carries one approval alone on its own page, with no checkbox to clear", () => {
    const html = renderToStaticMarkup(
      <ApprovalScreen item={item()} decideAction={() => undefined} />,
    );

    expect(html).toContain('type="hidden" name="ids" value="12"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('name="returnTo" value="/w/approvals/12"');
  });
});
