import type { RecordView } from "@hyperfixation/core/workspace";
import { draftFields } from "@hyperfixation/core/workspace";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordScreen } from "../app/(workspace)/w/[[...path]]/views";

/**
 * The record page's own rendering, without a database, a browser or a server.
 *
 * It exists for one assertion: everything on this page is model output or a row a run wrote, and
 * a draft that says `<img src=x onerror=…>` has to reach the DOM as those characters. React's
 * text rendering is what guarantees that, and `dangerouslySetInnerHTML` is what would undo it —
 * so the lint rule under `app/(workspace)/**` and this test are the two halves of the same claim.
 *
 * The timeline is here too because its groups are the other thing core hands over and the app
 * names: a group with no run is the one a human wrote, and it is labelled "manual".
 */
const INJECTION = '<img src=x onerror="alert(1)">';

const record = { table: "demo_note", recordType: "demoNote", title: "Demo notes" } as const;

function view(): RecordView {
  const draft = { to: "someone@example.com", subject: INJECTION, body: `Hello ${INJECTION}` };
  return {
    record,
    id: "7",
    title: "Acme Roofing",
    row: { id: "7", normalized_name: "acme roofing", body: INJECTION },
    archivedAt: null,
    timeline: [
      {
        runId: "run-1",
        flow: "draftDemoOutreach",
        startedAt: new Date("2026-09-19T10:00:00Z"),
        entries: [
          {
            id: 1,
            kind: "draft.sent",
            body: INJECTION,
            at: new Date("2026-09-19T10:01:00Z"),
            runId: "run-1",
            recordType: "demoNote",
            recordId: "7",
            actorId: null,
            meta: null,
          },
        ],
      },
      {
        runId: null,
        flow: null,
        startedAt: null,
        entries: [
          {
            id: 2,
            kind: "record.archived",
            body: "by hand",
            at: new Date("2026-09-19T11:00:00Z"),
            runId: null,
            recordType: "demoNote",
            recordId: "7",
            actorId: "user-1",
            meta: null,
          },
        ],
      },
    ],
    labels: [],
    outcomes: [],
    tasks: [],
    pendingApprovals: [
      {
        approvalId: 12,
        runId: "run-1",
        flow: "draftDemoOutreach",
        key: "draft:7",
        type: "demoDraft",
        recordType: "demoNote",
        recordId: "7",
        recordTitle: "Acme Roofing",
        assigneeId: null,
        createdAt: new Date("2026-09-19T10:02:00Z"),
        expiresAt: null,
        draft,
        fields: draftFields(draft),
        editable: true,
      },
    ],
  };
}

function render(): string {
  return renderToStaticMarkup(
    <RecordScreen
      view={view()}
      labelAction={() => undefined}
      archiveAction={() => undefined}
    />,
  );
}

describe("the record page", () => {
  it("renders a draft's markup as text and never as markup", () => {
    const html = render();

    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
    // The whole draft, not only the field the assertion above happens to hit.
    expect(html).not.toContain("onerror=\"alert(1)\"");
  });

  it("escapes the record's own columns and a run's activity body too", () => {
    const html = render();

    // `row` is the app table's row and `entries[].body` is what a step wrote: both are text.
    expect(html.match(/&lt;img src=x/g)?.length).toBeGreaterThan(2);
  });

  it("labels the group with no run as manual and names the others by flow", () => {
    const html = render();

    expect(html).toContain("<h3>manual</h3>");
    expect(html).toContain("<h3>draftDemoOutreach</h3>");
  });

  it("offers the archive form until the record is archived", () => {
    expect(render()).toContain("Archive");

    const archived = { ...view(), archivedAt: new Date("2026-09-19T12:00:00Z") };
    const html = renderToStaticMarkup(
      <RecordScreen
        view={archived}
        labelAction={() => undefined}
        archiveAction={() => undefined}
      />,
    );

    expect(html).not.toContain("Archive");
    expect(html).toContain("archived 2026-09-19T12:00:00.000Z");
  });
});
