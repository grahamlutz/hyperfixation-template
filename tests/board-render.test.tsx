import type { BoardCard, BoardView } from "@hyperfixation/core/workspace";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardScreen } from "../app/(workspace)/w/[[...path]]/board";

/**
 * The board's own rendering, without a database, a browser or a server.
 *
 * Three claims: the columns come out in the order the record type registered its stages — not
 * in whatever order the rows arrived — the "Other" column exists only when a row needs it, and a
 * card's title is model output and so reaches the DOM as text. The escaping half is the record
 * page's claim too, and it is repeated here because a second screen is a second chance to lose it.
 */
const INJECTION = '<img src=x onerror="alert(1)">';

const record = {
  table: "demo_note",
  recordType: "demoNote",
  title: "Demo notes",
  stages: [
    { name: "new", title: "New" },
    { name: "scored", title: "Scored" },
    { name: "drafted", title: "Drafted" },
  ],
} as const;

function card(id: string, stage: string | null, title = `Note ${id}`): BoardCard {
  return { id, title, stage, score: 42, updatedAt: new Date("2026-09-19T10:00:00Z") };
}

function view(overrides: Partial<BoardView> = {}): BoardView {
  return {
    record,
    columns: [
      { stage: record.stages[0], cards: [card("1", "new")] },
      { stage: record.stages[1], cards: [card("2", "scored"), card("3", "scored")] },
      { stage: record.stages[2], cards: [] },
    ],
    other: [],
    limit: 500,
    truncated: false,
    ...overrides,
  };
}

function render(board: BoardView): string {
  return renderToStaticMarkup(<BoardScreen view={board} />);
}

/** The column titles in the order they are rendered, out of `<h2>Scored <span …>2</span></h2>`. */
function headings(html: string): string[] {
  return [...html.matchAll(/<h2>([^<]*)</g)].map((match) => match[1]!.trim());
}

/** The count that column's heading carries — the `<span>` after the title. */
function countOf(html: string, title: string): string | undefined {
  return new RegExp(`<h2>${title} <span[^>]*>(\\d+)<`).exec(html)?.[1];
}

describe("the pipeline board", () => {
  it("renders one column per registered stage, in the record type's order", () => {
    expect(headings(render(view()))).toEqual(["New", "Scored", "Drafted"]);
  });

  it("counts each column, including the empty one", () => {
    const html = render(view());

    expect(countOf(html, "New")).toBe("1");
    expect(countOf(html, "Scored")).toBe("2");
    expect(countOf(html, "Drafted")).toBe("0");
    expect(html).toContain("None.");
  });

  it("adds the Other column only when a row is outside the registered stages", () => {
    expect(headings(render(view()))).not.toContain("Other");

    const withOther = render(view({ other: [card("9", null), card("10", "retired")] }));
    expect(headings(withOther)).toEqual(["New", "Scored", "Drafted", "Other"]);
    // Last, so the stages keep the order the record type gave them.
    expect(withOther.indexOf("Other")).toBeGreaterThan(withOther.indexOf("Drafted"));
  });

  it("renders a card's title as text and never as markup", () => {
    const html = render(view({ other: [card("11", null, INJECTION)] }));

    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it("links each card to its record page", () => {
    expect(render(view())).toContain('<a href="/w/demoNote/2">Note 2</a>');
  });

  it("says so when the record type has no rows at all", () => {
    const empty = render(
      view({ columns: record.stages.map((stage) => ({ stage, cards: [] })), other: [] }),
    );

    expect(empty).toContain("No records yet.");
    expect(empty).not.toContain("showing the first");
    // The columns are still there: an empty board is a board, not a message.
    expect(headings(empty)).toEqual(["New", "Scored", "Drafted"]);
  });

  it("says the board is truncated only when core says it was", () => {
    const cards = Array.from({ length: 3 }, (_, index) => card(String(index), "new"));
    const columns = [{ stage: record.stages[0], cards }];

    expect(render(view({ columns, other: [], limit: 3, truncated: true }))).toContain(
      "showing the first 3",
    );
    expect(render(view({ columns, other: [], limit: 3, truncated: false }))).not.toContain(
      "showing the first",
    );
  });
});
