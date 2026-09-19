import type { BoardCard, BoardView } from "@hyperfixation/core/workspace";
import type { CSSProperties } from "react";
import { MUTED, when } from "./views";

/**
 * The pipeline board: one column per registered stage, in the order the record type lists them,
 * and an "Other" column for a row whose `stage` is null or names no registered stage — shown
 * only when it has cards, so a record type whose rows all sit in a stage never grows a column
 * nobody asked for.
 *
 * Read-only on purpose. A record's stage is what a flow wrote, so there is nothing here to drag:
 * moving a card by hand would claim the flow's authority over a column it did not put the row in.
 *
 * Every card's title is model output and reaches the DOM as React text, same as the record page.
 */

/**
 * How many cards a board reads. Core's `board()` caps at 500 of its own accord but reports
 * neither the cap nor whether it was hit, so the limit is passed from here and the count is
 * compared against it — which is why this is a constant and not a literal at the call site.
 */
export const BOARD_LIMIT = 500;

export function BoardScreen({ view, limit }: { view: BoardView; limit: number }) {
  const { record } = view;
  const total = view.columns.reduce((sum, column) => sum + column.cards.length, 0) + view.other.length;

  return (
    <>
      <h1>{record.title ?? record.recordType}</h1>
      <p style={MUTED}>
        {total === 0 ? "No records yet." : `${total} records`}
        {/* `board()` returns rows, not a count, so a full page is the only evidence there may be
            more; saying "the first N" is the honest reading of it. */}
        {total >= limit ? ` · showing the first ${limit}` : ""}
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          gap: "1rem",
          overflowX: "auto",
        }}
      >
        {view.columns.map((column) => (
          <Column
            key={column.stage.name}
            title={column.stage.title}
            cards={column.cards}
            recordType={record.recordType}
          />
        ))}
        {view.other.length === 0 ? null : (
          <Column title="Other" cards={view.other} recordType={record.recordType} />
        )}
      </div>
    </>
  );
}

function Column({
  title,
  cards,
  recordType,
}: {
  title: string;
  cards: readonly BoardCard[];
  recordType: string;
}) {
  return (
    <section style={COLUMN}>
      <h2>
        {title} <span style={MUTED}>{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p style={MUTED}>None.</p>
      ) : (
        <ul style={{ padding: 0, margin: 0, listStyle: "none" }}>
          {cards.map((card) => (
            <li key={card.id}>
              <a href={`/w/${recordType}/${card.id}`}>{card.title ?? `${recordType} ${card.id}`}</a>
              <div style={MUTED}>
                {card.score === null ? "unscored" : `score ${card.score}`} · {when(card.updatedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Stacked on a phone, side by side once there is room for two — no media query either way. */
const COLUMN: CSSProperties = { flex: "1 1 12rem", minWidth: "12rem" };
